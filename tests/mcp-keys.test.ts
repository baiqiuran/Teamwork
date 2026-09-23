import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { applicationFixture, fixture } from "./support.ts";
import { legacy, seedLegacyAuthorization } from "./legacy-team-fixture.ts";
import { authorize, mcpClient } from "./mcp-support.ts";

test("成员 Key 只显示一次、持久化摘要、跨重启有效，并沿用权限与撤销边界", async (t) => {
  const f = await fixture(t);
  const input = { name: "本地助手", scopes: ["progress:read"] };
  assert.equal((await f.guest("/ai/keys", input)).status, 401);
  assert.equal(
    (await f.author("/ai/keys", { ...input, scopes: [] })).status,
    400,
  );
  assert.equal(
    (await f.author("/ai/keys", { ...input, scopes: ["admin"] })).status,
    400,
  );
  assert.equal(
    (await f.author("/ai/keys", { ...input, memberId: f.other.member.id }))
      .status,
    400,
  );
  const crossOrigin = await fetch(`${f.origin}/api/ai/keys`, {
    method: "POST",
    headers: {
      Origin: "https://other.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  assert.equal(crossOrigin.status, 403);
  const issued = await f.author("/ai/keys", input);
  assert.equal(issued.status, 201);
  assert.equal(issued.headers.get("cache-control"), "no-store");
  const { key, id } = issued.data;
  assert.match(key, /^dfk_[A-Za-z0-9_-]+$/);
  const db = new DatabaseSync(f.databasePath);
  try {
    const stored = db.prepare("SELECT * FROM ai_api_keys").all();
    assert.equal(stored.length, 1);
    assert.ok(!JSON.stringify(stored).includes(key));
    assert.notEqual(stored[0].hash, key);
    assert.equal(stored[0].grant_id, id);
  } finally {
    db.close();
  }
  const connections = (await f.author("/ai/connections")).data;
  assert.equal(connections[0].credentialType, "api-key");
  assert.equal(connections[0].name, input.name);
  assert.ok(!JSON.stringify(connections).includes(key));
  assert.deepEqual((await f.colleague("/ai/connections")).data, []);
  assert.equal(
    (await f.author(`/ai/connections/${id}/delete`, {})).status,
    409,
  );
  assert.equal(
    (await f.colleague(`/ai/connections/${id}/delete`, {})).status,
    404,
  );
  assert.equal(
    (await f.colleague(`/ai/connections/${id}/revoke`, {})).status,
    404,
  );
  f.setTime("2026-09-18T00:00:00Z");
  await f.restart();
  const client = await mcpClient(f.origin, key);
  t.after(() => client.close());
  const context = await client.callTool({ name: "get_context", arguments: {} });
  assert.equal(
    JSON.parse(JSON.stringify(context.structuredContent)).member.id,
    f.identity.member.id,
  );
  const tools = await client.listTools();
  assert.ok(!tools.tools.some((tool) => tool.name === "create_task"));
  await assert.rejects(
    client.callTool({
      name: "create_task",
      arguments: {
        operationId: randomUUID(),
        projectId: "unknown",
        name: "禁止创建",
        description: "",
      },
    }),
    /not found/,
  );
  // A Key cannot create additional keys through the member-only HTTP endpoint.
  const delegated = await fetch(`${f.origin}/api/ai/keys`, {
    method: "POST",
    headers: {
      Origin: f.origin,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  assert.equal(delegated.status, 401);
  await f.author(`/ai/connections/${id}/revoke`, {});
  assert.equal(
    (await f.author(`/ai/connections/${id}/delete`, {})).status,
    200,
  );
  assert.deepEqual((await f.author("/ai/connections")).data, []);
  assert.equal(
    (await f.author(`/ai/connections/${id}/delete`, {})).status,
    404,
  );
  const removed = new DatabaseSync(f.databasePath);
  try {
    assert.equal(
      removed.prepare("SELECT count(*) AS count FROM ai_api_keys").get()!.count,
      0,
    );
    assert.notEqual(
      removed.prepare("SELECT deleted_at FROM ai_grants WHERE id=?").get(id)!
        .deleted_at,
      null,
    );
  } finally {
    removed.close();
  }
  await f.restart();
  assert.deepEqual((await f.author("/ai/connections")).data, []);
  const rejected = await fetch(`${f.origin}/mcp`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  assert.equal(rejected.status, 401);
  const invalid = await fetch(`${f.origin}/mcp`, {
    headers: { Authorization: "Bearer dfk_invalid" },
  });
  assert.equal(invalid.status, 401);
  assert.ok(
    !JSON.stringify((await f.author("/ai/operations")).data).includes(key),
  );
});

test("版本 6 升级保留 OAuth 连接和凭证，并可创建 Key", async (t) => {
  const f = await applicationFixture(t, {}, (path, origin) => {
    seedLegacyAuthorization(path, origin);
    const db = new DatabaseSync(path);
    try {
      db.exec(
        "DROP TABLE ai_api_keys; DELETE FROM ai_grants WHERE credential_type='api-key'; ALTER TABLE ai_grants DROP COLUMN credential_type; ALTER TABLE ai_grants DROP COLUMN name; DELETE FROM schema_migrations WHERE version>6;",
      );
    } finally {
      db.close();
    }
  });
  const author = f.client(`daily_session=${legacy.session}`);
  const after = (await author("/ai/connections")).data;
  const oauth = after.find(
    (connection: { id: string }) => connection.id === "legacy-oauth",
  );
  assert.equal(oauth.credentialType, "oauth");
  assert.equal(oauth.name, null);
  assert.equal(oauth.lastReadSucceededAt, null);
  const client = await mcpClient(f.origin, "legacy-oauth");
  t.after(() => client.close());
  assert.ok(
    !(await client.callTool({ name: "get_context", arguments: {} })).isError,
  );
  assert.equal(
    (await author("/ai/keys", { name: "升级后", scopes: ["progress:read"] }))
      .status,
    201,
  );
  await f.restart();
  assert.equal((await author("/me")).data.member.id, legacy.member.id);
});

async function runPackage(env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolveResult, reject) => {
      const child = spawn(
        process.execPath,
        [resolve("packages/mcp-node/bin/daily-flow-mcp.mjs")],
        { env, stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "";
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("Node 包未按期退出"));
      }, 20000);
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolveResult({ code, stdout, stderr });
      });
    },
  );
}

test("Node 包拒绝不安全地址与重定向，错误不泄露 Key", async (t) => {
  const key = "dfk_only_a_test_secret";
  for (const url of [
    "http://example.com",
    "https://example.com/mcp?ak=secret",
    "https://user:password@example.com",
    "https://example.com/other",
  ]) {
    const result = await runPackage({
      DAILY_FLOW_API_KEY: key,
      DAILY_FLOW_URL: url,
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(key));
    assert.ok(!result.stderr.includes(url));
  }
  let escaped = false;
  const server = createServer((request, response) => {
    if (request.url === "/steal") escaped = true;
    response.writeHead(307, { Location: "/steal" });
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const result = await runPackage({
    DAILY_FLOW_API_KEY: key,
    DAILY_FLOW_URL: `http://127.0.0.1:${address.port}`,
  });
  assert.equal(result.code, 1);
  assert.equal(escaped, false);
  assert.equal(result.stdout, "");
  assert.ok(!result.stderr.includes(key));
});

test("Node stdio 包传递真实工具契约和写入回执，撤销后不能调用或重放", async (t) => {
  const f = await fixture(t);
  const issued = await f.author("/ai/keys", {
    name: "stdio",
    scopes: ["progress:read", "tasks:write"],
  });
  const project = (
    await f.author("/projects", { name: "Node 项目", description: "" })
  ).data;
  const archive = process.env.DAILY_FLOW_TEST_PACKAGE;
  const windows = process.platform === "win32";
  const transportFor = (key: string) =>
    new StdioClientTransport({
      command: archive
        ? windows
          ? process.env.ComSpec!
          : "npx"
        : process.execPath,
      args: archive
        ? [
            ...(windows ? ["/c", "npx"] : []),
            "--yes",
            `--package=${archive}`,
            "daily-flow-mcp",
          ]
        : [resolve("packages/mcp-node/bin/daily-flow-mcp.mjs")],
      env: { DAILY_FLOW_URL: f.origin, DAILY_FLOW_API_KEY: key },
      stderr: "pipe",
    });
  const transport = transportFor(issued.data.key);
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: "stdio-integration", version: "1" });
  t.after(async () => {
    await client.close();
    assert.ok(!stderr.includes(issued.data.key));
  });
  await client.connect(transport);
  assert.ok(client.getInstructions()?.includes("版本冲突"));
  const listed = await client.listTools();
  const connection = async () =>
    (await f.author("/ai/connections")).data.find(
      (item: { id: string }) => item.id === issued.data.id,
    );
  assert.equal((await connection()).lastReadSucceededAt, null);
  assert.ok(
    listed.tools.find((tool) => tool.name === "create_task")?.outputSchema,
  );
  assert.ok(!listed.tools.some((tool) => tool.name === "create_share"));
  const failedRead = await client.callTool({
    name: "get_project",
    arguments: { id: randomUUID() },
  });
  assert.ok(failedRead.isError);
  assert.equal((await connection()).lastReadSucceededAt, null);
  assert.deepEqual((await f.colleague("/ai/connections")).data, []);
  const emptyRead = await client.callTool({
    name: "list_projects",
    arguments: { query: "no-such-project-2026" },
  });
  assert.ok(!emptyRead.isError, JSON.stringify(emptyRead));
  assert.ok((await connection()).lastReadSucceededAt > 0);
  const input = {
    operationId: randomUUID(),
    projectId: project.id,
    name: "从 Node 创建",
    description: "",
  };
  const created = await client.callTool({
    name: "create_task",
    arguments: input,
  });
  assert.ok(!created.isError, JSON.stringify(created));
  assert.equal(
    JSON.parse(JSON.stringify(created.structuredContent)).replayed,
    false,
  );
  const repeated = await client.callTool({
    name: "create_task",
    arguments: input,
  });
  assert.equal(
    JSON.parse(JSON.stringify(repeated.structuredContent)).replayed,
    true,
  );
  const conflict = await client.callTool({
    name: "create_task",
    arguments: { ...input, name: "不同意图" },
  });
  assert.ok(conflict.isError);
  assert.match(JSON.stringify(conflict), /operation-id-conflict/);
  const task = JSON.parse(JSON.stringify(created.structuredContent)).task;
  assert.equal((await f.author(`/tasks/${task.id}`)).data.name, input.name);
  // Existing OAuth uses the same receipts and remains usable after Key revocation.
  const token = await authorize(f, ["progress:read", "tasks:write"]);
  const oauth = await mcpClient(f.origin, token.access_token);
  t.after(() => oauth.close());
  const oauthReplay = await oauth.callTool({
    name: "create_task",
    arguments: input,
  });
  assert.equal(
    JSON.parse(JSON.stringify(oauthReplay.structuredContent)).replayed,
    true,
  );
  const replacement = await f.author("/ai/keys", {
    name: "stdio 新连接",
    scopes: ["progress:read"],
  });
  const replacementClient = new Client({
    name: "stdio-replacement",
    version: "1",
  });
  t.after(() => replacementClient.close());
  await replacementClient.connect(transportFor(replacement.data.key));
  assert.ok(
    !(await replacementClient.listTools()).tools.some(
      (tool) => tool.name === "create_task",
    ),
  );
  const replacementConnection = async () =>
    (await f.author("/ai/connections")).data.find(
      (item: { id: string }) => item.id === replacement.data.id,
    );
  assert.equal((await replacementConnection()).lastReadSucceededAt, null);
  assert.ok(
    (
      await replacementClient.callTool({
        name: "get_project",
        arguments: { id: randomUUID() },
      })
    ).isError,
  );
  assert.equal((await replacementConnection()).lastReadSucceededAt, null);
  assert.ok(
    !(await client.callTool({ name: "list_projects", arguments: {} })).isError,
  );
  assert.ok(
    !(
      await replacementClient.callTool({
        name: "list_projects",
        arguments: { query: "no-such-project-replacement-2026" },
      })
    ).isError,
  );
  assert.ok((await replacementConnection()).lastReadSucceededAt > 0);
  await f.author(`/ai/connections/${issued.data.id}/revoke`, {});
  const historyBeforeDelete = (await f.author("/ai/operations")).data.items;
  assert.ok(historyBeforeDelete.length > 0);
  assert.equal(
    (await f.author(`/ai/connections/${issued.data.id}/delete`, {})).status,
    200,
  );
  assert.deepEqual(
    (await f.author("/ai/operations")).data.items,
    historyBeforeDelete,
  );
  const revoked = await client.callTool({
    name: "create_task",
    arguments: input,
  });
  assert.ok(revoked.isError);
  assert.ok(
    !(
      await replacementClient.callTool({ name: "list_projects", arguments: {} })
    ).isError,
  );
  await assert.rejects(client.listTools(undefined, { cacheMode: "bypass" }));
  assert.equal(
    (await oauth.callTool({ name: "get_context", arguments: {} })).isError,
    undefined,
  );
});
