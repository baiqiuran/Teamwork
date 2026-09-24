import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { applicationFixture, fixture } from "./support.ts";
import { legacy, seedLegacyAuthorization } from "./legacy-team-fixture.ts";
import { authorize, mcpClient } from "./mcp-support.ts";
import { createUnconfiguredApp } from "./application.ts";

test("本人独立登录及重启后可回看同一成员 Key，普通响应不携带恢复材料", async (t) => {
  const f = await fixture(t);
  const issued = await f.author("/ai/keys", {
    name: "可回看",
    scopes: ["progress:read"],
  });
  assert.equal(issued.status, 201);
  const { id, key } = issued.data;
  const anotherLogin = f.client();
  assert.equal(
    (
      await anotherLogin("/login", {
        email: f.credentials.email,
        password: f.credentials.password,
      })
    ).status,
    200,
  );
  const reveal = async () => {
    const response = await anotherLogin(`/ai/connections/${id}/key`, {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(response.data, { key });
  };
  await reveal();
  await f.restart();
  await reveal();
  const db = new DatabaseSync(f.databasePath);
  try {
    const rows = db.prepare("SELECT * FROM ai_api_keys").all();
    assert.ok(!JSON.stringify(rows).includes(key));
    assert.equal(typeof rows[0].encrypted_key, "string");
    for (const path of ["/ai/connections", "/ai/operations"]) {
      const body = JSON.stringify((await anotherLogin(path)).data);
      assert.ok(!body.includes(key));
      assert.ok(!body.includes(String(rows[0].encrypted_key)));
      assert.ok(!body.includes(String(rows[0].hash)));
    }
  } finally {
    db.close();
  }
  for (const path of [f.databasePath, `${f.databasePath}-wal`]) {
    const bytes = await readFile(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return Buffer.alloc(0);
      throw error;
    });
    assert.ok(
      !bytes.includes(Buffer.from(key)),
      "SQLite 持久化产物不得包含 Key 明文",
    );
  }
  const [connection] = (await anotherLogin("/ai/connections")).data;
  assert.equal(connection.canRevealKey, true);
  assert.equal(connection.lastReadSucceededAt, null);
});

test("回看仅限本人网页登录，拒绝其他成员、团队、Bearer、撤销、删除及 OAuth 连接", async (t) => {
  const f = await fixture(t);
  const outside = f.client();
  await outside("/setup", {
    ...f.credentials,
    email: "outside@example.test",
    teamName: "另一团队",
  });
  const first = (
    await f.author("/ai/keys", { name: "一", scopes: ["progress:read"] })
  ).data;
  const second = (
    await f.author("/ai/keys", { name: "二", scopes: ["progress:read"] })
  ).data;
  const token = await authorize(f, ["progress:read"]);
  const path = `/ai/connections/${first.id}/key`;
  for (const [client, status] of [
    [f.guest, 401],
    [f.colleague, 404],
    [outside, 404],
  ] as const) {
    const response = await client(path, {});
    assert.equal(response.status, status);
    assert.ok(!JSON.stringify(response.data).includes(first.key));
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  for (const bearer of [first.key, token.access_token]) {
    const response = await fetch(`${f.origin}/api${path}`, {
      method: "POST",
      headers: {
        Origin: f.origin,
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(response.status, 401);
    assert.ok(!(await response.text()).includes(first.key));
  }
  const oauth = (await f.author("/ai/connections")).data.find(
    (c: { credentialType: string }) => c.credentialType === "oauth",
  );
  assert.equal(oauth.canRevealKey, false);
  assert.equal(
    (await f.author(`/ai/connections/${oauth.id}/key`, {})).status,
    404,
  );
  assert.equal((await f.author(path, {})).data.key, first.key);
  assert.equal(
    (await f.author(`/ai/connections/${second.id}/key`, {})).data.key,
    second.key,
  );
  const before = (await f.author("/ai/operations")).data;
  await f.author(`/ai/connections/${first.id}/revoke`, {});
  assert.equal((await f.author(path, {})).status, 404);
  const revoked = (await f.author("/ai/connections")).data.find(
    (c: { id: string }) => c.id === first.id,
  );
  assert.equal(revoked.canRevealKey, false);
  await f.author(`/ai/connections/${first.id}/delete`, {});
  assert.equal((await f.author(path, {})).status, 404);
  assert.equal(
    (await f.author(`/ai/connections/${second.id}/key`, {})).data.key,
    second.key,
  );
  assert.deepEqual((await f.author("/ai/operations")).data, before);
});

test("缺少主密钥明确禁用新签发和回看，不影响已有摘要认证及 OAuth", async (t) => {
  const f = await fixture(t);
  const issued = (
    await f.author("/ai/keys", { name: "保留认证", scopes: ["progress:read"] })
  ).data;
  const token = await authorize(f, ["progress:read"]);
  const before = (await f.author("/ai/connections")).data;
  await f.stop();
  const raw = await createUnconfiguredApp({
    databasePath: f.databasePath,
    now: () => Date.parse("2026-09-16T15:59:00Z"),
  });
  try {
    await raw.listen(Number(new URL(f.origin).port));
    for (const path of ["/ai/keys", `/ai/connections/${issued.id}/key`]) {
      const response = await f.author(path, {
        name: "不得部分签发",
        scopes: ["progress:read"],
      });
      assert.equal(response.status, 503);
      assert.equal(response.data.error, "key_unavailable");
      assert.ok(!JSON.stringify(response.data).includes(issued.key));
    }
    assert.deepEqual((await f.author("/ai/connections")).data, before);
    for (const credential of [issued.key, token.access_token]) {
      const client = await mcpClient(f.origin, credential);
      try {
        assert.ok(
          !(await client.callTool({ name: "get_context", arguments: {} }))
            .isError,
        );
      } finally {
        await client.close();
      }
    }
  } finally {
    await raw.close();
  }
});

test("无效主密钥文件安全拒绝启动，密文替换和损坏拒绝回看，存储失败不留下部分授权", async (t) => {
  const files = await keyFiles(t);
  const invalid = `not-a-master-${randomUUID()}`;
  const invalidFile = await files.write(invalid);
  for (const path of [
    invalidFile,
    files.directory,
    join(files.directory, "missing"),
  ]) {
    await assert.rejects(
      createUnconfiguredApp({
        databasePath: join(files.directory, `${randomUUID()}.sqlite`),
        aiKeyMasterFile: path,
      }),
      (error: Error) => {
        assert.match(error.message, /DAILY_AI_KEY_MASTER_FILE/);
        assertNoSecrets(error.message, [invalid, path]);
        return true;
      },
    );
  }
  const f = await fixture(t);
  const keys = [];
  for (const name of ["一", "二"])
    keys.push(
      (await f.author("/ai/keys", { name, scopes: ["progress:read"] })).data,
    );
  const db = new DatabaseSync(f.databasePath);
  try {
    const original = String(
      db
        .prepare("SELECT encrypted_key FROM ai_api_keys WHERE grant_id=?")
        .get(keys[0].id)!.encrypted_key,
    );
    const other = String(
      db
        .prepare("SELECT encrypted_key FROM ai_api_keys WHERE grant_id=?")
        .get(keys[1].id)!.encrypted_key,
    );
    const [version, nonce, ciphertext, tag] = original.split(".");
    const changedTag = `${tag[0] === "A" ? "B" : "A"}${tag.slice(1)}`;
    for (const broken of [
      other,
      [version, nonce, ciphertext, changedTag].join("."),
      "",
    ]) {
      db.prepare("UPDATE ai_api_keys SET encrypted_key=? WHERE grant_id=?").run(
        broken,
        keys[0].id,
      );
      const response = await f.author(`/ai/connections/${keys[0].id}/key`, {});
      assert.equal(response.status, 503);
      assertNoSecrets(JSON.stringify(response.data), [
        keys[0].key,
        keys[1].key,
        original,
        broken,
      ]);
    }
    db.prepare("UPDATE ai_api_keys SET encrypted_key=? WHERE grant_id=?").run(
      original,
      keys[0].id,
    );
    assert.equal(
      (await f.author(`/ai/connections/${keys[0].id}/key`, {})).data.key,
      keys[0].key,
    );
    const before = (await f.author("/ai/connections")).data;
    db.exec(
      "CREATE TRIGGER reject_key BEFORE INSERT ON ai_api_keys BEGIN SELECT RAISE(ABORT, 'credential-storage-rejected'); END;",
    );
    const failure = await f.author("/ai/keys", {
      name: "失败不能留下记录",
      scopes: ["progress:read"],
    });
    assert.equal(failure.status, 503);
    assert.equal(failure.data.error, "key_unavailable");
    assert.deepEqual((await f.author("/ai/connections")).data, before);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM ai_api_keys").get()!.n,
      2,
    );
  } finally {
    db.close();
  }
});

test("迁移只含摘要的旧 Key 不伪造正文，保留认证并允许主动创建可回看新 Key", async (t) => {
  const f = await applicationFixture(t, {}, (path, origin) => {
    seedLegacyAuthorization(path, origin);
    const db = new DatabaseSync(path);
    try {
      db.prepare(
        "INSERT INTO ai_operations (id,member_id,grant_id,client_id,tool,object_id,at,outcome,error_code) VALUES (?,?,?,?,?,?,?,?,?)",
      ).run(
        "legacy-operation",
        legacy.member.id,
        "legacy-key",
        "daily-flow-codex",
        "create_task",
        null,
        legacy.at,
        "success",
        null,
      );
    } finally {
      db.close();
    }
  });
  const author = f.client(`daily_session=${legacy.session}`);
  const connections = (await author("/ai/connections")).data;
  const old = connections.find((c: { id: string }) => c.id === "legacy-key");
  const revokedLegacy = connections.find(
    (c: { id: string }) => c.id === "legacy-revoked-key",
  );
  assert.equal(old.canRevealKey, false);
  assert.equal(old.name, "legacy-key");
  assert.deepEqual(old.scopes, ["progress:read", "tasks:write"]);
  assert.equal(old.lastReadSucceededAt, null);
  assert.equal(revokedLegacy.canRevealKey, false);
  assert.equal(
    (await author("/ai/connections/legacy-revoked-key/key", {})).status,
    404,
  );
  const history = await author("/ai/operations");
  assert.equal(
    history.data.items.find(
      (item: { id: string }) => item.id === "legacy-operation",
    ).tool,
    "create_task",
  );
  const response = await author("/ai/connections/legacy-key/key", {});
  assert.equal(response.status, 409);
  assert.equal(response.data.error, "key_not_recoverable");
  const client = await mcpClient(f.origin, "dfk_legacy-key");
  t.after(() => client.close());
  assert.ok(
    !(await client.callTool({ name: "list_projects", arguments: {} })).isError,
  );
  const issued = (
    await author("/ai/keys", { name: "主动更换", scopes: ["progress:read"] })
  ).data;
  assert.equal(
    (await author(`/ai/connections/${issued.id}/key`, {})).data.key,
    issued.key,
  );
  assert.ok(
    !(await client.callTool({ name: "list_projects", arguments: {} })).isError,
  );
  // The member revokes the old connection only after the new one is verified.
  assert.equal(
    (await author(`/ai/connections/${issued.id}/key`, {})).status,
    200,
  );
  await author("/ai/connections/legacy-key/revoke", {});
  assert.equal(
    (await author("/ai/connections/legacy-key/key", {})).status,
    404,
  );
  assert.equal(
    (
      await fetch(`${f.origin}/mcp`, {
        headers: { Authorization: "Bearer dfk_legacy-key" },
      })
    ).status,
    401,
  );
  const oauth = await mcpClient(f.origin, "legacy-oauth");
  t.after(() => oauth.close());
  assert.ok(
    !(await oauth.callTool({ name: "get_context", arguments: {} })).isError,
  );
  assert.ok(
    !(
      await (
        await mcpClient(f.origin, issued.key)
      ).callTool({ name: "list_projects", arguments: {} })
    ).isError,
  );
  assert.equal(
    (await author("/ai/connections/legacy-key/delete", {})).status,
    200,
  );
  assert.equal(
    (await author("/ai/operations")).data.items.length,
    history.data.items.length,
  );
});

test("错误主密钥拒绝回看且不泄密，配套主密钥恢复后取回原 Key", async (t) => {
  const masters = await keyFiles(t);
  const master = async () => {
    const hex = randomBytes(32).toString("hex");
    return { hex, path: await masters.write(`${hex}\n`) };
  };
  const originalMaster = await master();
  const wrongMaster = await master();
  const f = await fixture(t, { aiKeyMasterFile: originalMaster.path });
  const issued = (
    await f.author("/ai/keys", { name: "配套恢复", scopes: ["progress:read"] })
  ).data;
  const reveal = (id: string) => `/ai/connections/${id}/key`;
  assert.equal((await f.author(reveal(issued.id), {})).data.key, issued.key);
  // Each phase runs a real application on its own port against the same SQLite,
  // so a mismatched master is exercised exactly like a mis-deployed restart.
  async function withMaster(
    databasePath: string,
    aiKeyMasterFile: string,
    run: (context: {
      origin: string;
      author: (
        path: string,
        body?: unknown,
      ) => Promise<{
        status: number;
        data: any;
      }>;
    }) => Promise<void>,
  ) {
    const service = await createUnconfiguredApp({
      databasePath,
      aiKeyMasterFile,
      now: () => Date.parse("2026-09-17T15:59:00Z"),
    });
    const server = await service.listen(0, "127.0.0.1");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    let cookie = "";
    const author = async (path: string, body?: unknown) => {
      const response = await fetch(`${origin}/api${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = response.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      return { status: response.status, data: await response.json() };
    };
    let open = true;
    t.after(async () => {
      if (open) await service.close();
    });
    try {
      assert.equal(
        (
          await author("/login", {
            email: f.credentials.email,
            password: f.credentials.password,
          })
        ).status,
        200,
      );
      await run({ origin, author });
    } finally {
      await service.close();
      open = false;
    }
  }
  let underWrongId = "",
    underWrongKey = "";
  await withMaster(f.databasePath, wrongMaster.path, async ({ author }) => {
    // A syntactically valid but mismatched master must not open old envelopes.
    const failed = await author(reveal(issued.id), {});
    assert.equal(failed.status, 503);
    assert.equal(failed.data.error, "key_unavailable");
    assertNoSecrets(JSON.stringify(failed.data), [
      issued.key,
      originalMaster.hex,
      wrongMaster.hex,
      wrongMaster.path,
    ]);
    const created = await author("/ai/keys", {
      name: "错钥期间签发",
      scopes: ["progress:read"],
    });
    assert.equal(created.status, 201);
    underWrongId = created.data.id;
    underWrongKey = created.data.key;
    assert.equal(
      (await author(reveal(underWrongId), {})).data.key,
      underWrongKey,
    );
  });
  const snapshot = join(masters.directory, "配套快照.sqlite");
  const copy = new DatabaseSync(f.databasePath);
  try {
    copy.prepare("VACUUM INTO ?").run(snapshot);
  } finally {
    copy.close();
  }
  // The paired database plus its original master returns the same Key again.
  await withMaster(snapshot, originalMaster.path, async ({ author }) => {
    const restored = await author(reveal(issued.id), {});
    assert.equal(restored.data.key, issued.key);
    assertNoSecrets(JSON.stringify(restored.data), [wrongMaster.hex]);
  });
  // The copied database alone never yields the plaintext.
  await withMaster(snapshot, wrongMaster.path, async ({ author }) => {
    const alone = await author(reveal(issued.id), {});
    assert.equal(alone.status, 503);
    assertNoSecrets(JSON.stringify(alone.data), [
      issued.key,
      originalMaster.hex,
    ]);
  });
  // The mismatched run must not have rotated or destroyed anything: the original
  // master still reveals the original Key and its digest keeps authenticating.
  assert.equal((await f.author(reveal(issued.id), {})).data.key, issued.key);
  const client = await mcpClient(f.origin, issued.key);
  try {
    assert.ok(
      !(await client.callTool({ name: "list_projects", arguments: {} }))
        .isError,
    );
  } finally {
    await client.close();
  }
  // A Key issued while the wrong master was active is not readable afterwards,
  // so operators must verify the paired master before opening issuance.
  const orphaned = await f.author(reveal(underWrongId), {});
  assert.equal(orphaned.status, 503);
  assertNoSecrets(JSON.stringify(orphaned.data), [
    underWrongKey,
    wrongMaster.hex,
  ]);
});

test("成员 Key 持久化摘要、跨重启有效，并沿用权限与撤销边界", async (t) => {
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
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolveResult({ code, stdout, stderr });
      });
    },
  );
}

async function keyFiles(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "daily-flow-mcp 密钥 "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    async write(content: string) {
      const path = join(directory, `成员 Key ${randomUUID()}.txt`);
      await writeFile(path, content, "utf8");
      return path;
    },
  };
}

function assertNoSecrets(output: string, secrets: string[]) {
  for (const secret of secrets.filter(Boolean)) {
    assert.ok(!output.includes(secret), "输出不得包含凭证、文件内容或路径");
  }
}

function assertStartupFailure(
  result: Awaited<ReturnType<typeof runPackage>>,
  message: string,
  secrets: string[],
) {
  assertNoSecrets(result.stdout + result.stderr, secrets);
  assert.equal(result.code, 1);
  assert.ok(result.stdout === "", "启动失败不得向 stdout 输出内容");
  assert.ok(result.stderr.trim() === message, "启动失败须输出固定脱敏提示");
}

function observePackageOutput(transport: StdioClientTransport) {
  let stdout = "",
    stderr = "",
    transportErrors = 0;
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const start = transport.start.bind(transport);
  transport.start = async () => {
    const onmessage = transport.onmessage;
    const onerror = transport.onerror;
    // Reject non-protocol stdout instead of letting the SDK discard leaked logs.
    transport.onmessage = (...args) => {
      stdout += JSON.stringify(args[0]);
      onmessage?.(...args);
    };
    transport.onerror = (error) => {
      transportErrors++;
      onerror?.(error);
    };
    await start();
  };
  return (secrets: string[]) => {
    assertNoSecrets(stdout + stderr, secrets);
    assert.equal(transportErrors, 0, "stdio 不得出现非协议输出或传输错误");
  };
}

test("Node 包拒绝同时设置两个 Key 来源，包括任一空值", async (t) => {
  const files = await keyFiles(t);
  const key = `dfk_${randomUUID()}`;
  const path = await files.write(key);
  for (const envKey of [key, ""]) {
    for (const file of [path, ""]) {
      const result = await runPackage({
        DAILY_FLOW_API_KEY: envKey,
        DAILY_FLOW_API_KEY_FILE: file,
        DAILY_FLOW_URL: "http://127.0.0.1:1",
      });
      assertStartupFailure(
        result,
        "DAILY_FLOW_API_KEY_FILE 与 DAILY_FLOW_API_KEY 不能同时设置（包括空值）。",
        [key, path],
      );
    }
  }
});

test("Node 包明确拒绝缺失、空值和不可用的 Key 来源且不泄密", async (t) => {
  const files = await keyFiles(t);
  const key = `dfk_${randomUUID()}`;
  const invalid = `invalid-${randomUUID()}`;
  const missing = join(files.directory, "缺失 Key.txt");
  const relative = "./本地 Key.txt";
  const cases: {
    name: string;
    env: Record<string, string>;
    message: string;
    secrets?: string[];
  }[] = [
    {
      name: "未设置来源",
      env: {},
      message:
        "请设置 DAILY_FLOW_API_KEY_FILE（推荐）或 DAILY_FLOW_API_KEY，且仅设置其中一个。",
    },
    ...["", " \t\r\n", invalid, "dfk_", `${key}\n`, ` ${key}`].map(
      (value, index) => ({
        name: `环境变量空值或格式错误 ${index}`,
        env: { DAILY_FLOW_API_KEY: value },
        message: "请设置有效的 DAILY_FLOW_API_KEY。",
        secrets: [key, invalid],
      }),
    ),
    ...["", "   ", relative].map((value, index) => ({
      name: `文件路径空值或相对路径 ${index}`,
      env: { DAILY_FLOW_API_KEY_FILE: value },
      message: "DAILY_FLOW_API_KEY_FILE 须为非空的本机绝对路径。",
      secrets: [relative],
    })),
    ...[missing, files.directory].map((value, index) => ({
      name: `文件缺失或目录不可读 ${index}`,
      env: { DAILY_FLOW_API_KEY_FILE: value },
      message: "无法读取 Key 文件，请检查文件是否存在且可读。",
      secrets: [value],
    })),
  ];
  for (const [index, content] of ["", " \t\r\n"].entries()) {
    const path = await files.write(content);
    cases.push({
      name: `文件为空或仅含空白 ${index}`,
      env: { DAILY_FLOW_API_KEY_FILE: path },
      message: "Key 文件不能为空或仅含空白。",
      secrets: [path],
    });
  }
  for (const [index, content] of [
    invalid,
    "dfk_",
    ` ${key}`,
    `${key} `,
    `${key}\n${key}`,
    JSON.stringify({ key }),
    `DAILY_FLOW_API_KEY=${key}`,
    `${key}\u0000`,
  ].entries()) {
    const path = await files.write(content);
    cases.push({
      name: `文件格式错误 ${index}`,
      env: { DAILY_FLOW_API_KEY_FILE: path },
      message: "Key 文件格式无效，请仅保存成员授权 Key（允许末尾换行）。",
      secrets: [key, invalid, content, path],
    });
  }
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const result = await runPackage({
        DAILY_FLOW_URL: "http://127.0.0.1:1",
        ...entry.env,
      });
      assertStartupFailure(result, entry.message, [
        files.directory,
        ...(entry.secrets ?? []),
      ]);
    });
  }
});

for (const source of ["env", "file"] as const) {
  test(`Node 包（${source}）拒绝不安全地址与重定向，错误不泄露 Key`, async (t) => {
    const key = `dfk_${randomUUID()}`;
    const files = await keyFiles(t);
    const credentials: Record<string, string> =
      source === "env"
        ? { DAILY_FLOW_API_KEY: key }
        : { DAILY_FLOW_API_KEY_FILE: await files.write(key) };
    for (const url of [
      "http://example.com",
      "https://example.com/mcp?ak=secret",
      "https://user:password@example.com",
      "https://example.com/other",
    ]) {
      const result = await runPackage({
        ...credentials,
        DAILY_FLOW_URL: url,
      });
      assertNoSecrets(result.stdout + result.stderr, [
        key,
        files.directory,
        url,
      ]);
      assert.equal(result.code, 1);
      assert.ok(result.stdout === "", "启动失败不得向 stdout 输出内容");
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
      ...credentials,
      DAILY_FLOW_URL: `http://127.0.0.1:${address.port}`,
    });
    assertStartupFailure(
      result,
      "无法连接日序 MCP，请检查服务地址、网络和 Key 是否有效或已撤销。",
      [key, files.directory],
    );
    assert.equal(result.code, 1);
    assert.equal(escaped, false);
    assert.ok(result.stdout === "", "启动失败不得向 stdout 输出内容");
    assert.ok(!result.stderr.includes(key));
  });
}

for (const source of ["env", "file"] as const) {
  test(`Node stdio 包（${source}）传递真实工具契约和写入回执，撤销后不能调用或重放`, async (t) => {
    const f = await fixture(t);
    const files = await keyFiles(t);
    const secrets = [files.directory];
    const credentialsFor = async (
      key: string,
      ending = "\n",
    ): Promise<Record<string, string>> => {
      secrets.push(key);
      if (source === "env") return { DAILY_FLOW_API_KEY: key };
      const path = await files.write(key + ending);
      secrets.push(path);
      return { DAILY_FLOW_API_KEY_FILE: path };
    };
    const issued = await f.author("/ai/keys", {
      name: "stdio",
      scopes: ["progress:read", "tasks:write"],
    });
    const project = (
      await f.author("/projects", { name: "Node 项目", description: "" })
    ).data;
    const archive = process.env.DAILY_FLOW_TEST_PACKAGE;
    const windows = process.platform === "win32";
    const transportFor = (env: Record<string, string>) => {
      const transport = new StdioClientTransport({
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
        env: { DAILY_FLOW_URL: f.origin, ...env },
        stderr: "pipe",
      });
      const checkOutput = observePackageOutput(transport);
      t.after(async () => {
        await transport.close();
        checkOutput(secrets);
      });
      return transport;
    };
    const credentials = await credentialsFor(issued.data.key);
    const transport = transportFor(credentials);
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
    if (source === "file") {
      // Removing the file after startup must not interrupt reads or writes.
      await rm(credentials.DAILY_FLOW_API_KEY_FILE);
    }
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
    await replacementClient.connect(
      transportFor(await credentialsFor(replacement.data.key, "\r\n")),
    );
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
      !(await client.callTool({ name: "list_projects", arguments: {} }))
        .isError,
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
    for (const key of [`dfk_${randomUUID()}`, issued.data.key]) {
      const result = await runPackage({
        DAILY_FLOW_URL: f.origin,
        ...(await credentialsFor(key, "")),
      });
      assertStartupFailure(
        result,
        "无法连接日序 MCP，请检查服务地址、网络和 Key 是否有效或已撤销。",
        secrets,
      );
    }
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
        await replacementClient.callTool({
          name: "list_projects",
          arguments: {},
        })
      ).isError,
    );
    await assert.rejects(client.listTools(undefined, { cacheMode: "bypass" }));
    assert.equal(
      (await oauth.callTool({ name: "get_context", arguments: {} })).isError,
      undefined,
    );
  });
}
