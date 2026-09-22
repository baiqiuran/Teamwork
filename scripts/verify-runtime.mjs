import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";

// Always use disposable synthetic data, even when inspecting a prepared release.
const runtime = resolve(process.argv[2]);
const directory = await mkdtemp(resolve(tmpdir(), "daily-runtime-"));
let child;
try {
  const require = createRequire(resolve(runtime, "package.json"));
  for (const module of ["tsx", "typescript", "@nestjs/cli"])
    assert.throws(() => require.resolve(module), { code: "MODULE_NOT_FOUND" });

  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const origin = `http://127.0.0.1:${port}`;
  const environment = {
    ...process.env,
    PORT: String(port),
    DAILY_DATABASE_PATH: resolve(directory, "test.sqlite"),
  };
  for (const key of Object.keys(environment))
    if (key.startsWith("DAILY_") && key !== "DAILY_DATABASE_PATH")
      delete environment[key];
  environment.NODE_ENV = "production";
  delete environment.NODE_TEST_CONTEXT;
  child = spawn(process.execPath, ["build/server/main.js"], {
    cwd: runtime,
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr.on("data", (data) => {
    output += data;
  });
  await new Promise((ready, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Runtime startup timeout: ${output}`)),
      60000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(output));
    });
    child.stdout.on("data", (data) => {
      output += data;
      const lines = output.split(/\r?\n/);
      if (
        lines.includes(`日序已启动：${origin}`) &&
        lines.includes(`创建团队：${origin}/setup`)
      ) {
        clearTimeout(timer);
        ready();
      }
    });
  });
  assert.doesNotMatch(output, /setup#key=|引导密钥|仅本机使用/);
  let cookie = "";
  async function request(path, body, status = 200, anonymous = false) {
    const response = await fetch(origin + "/api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: anonymous ? "" : cookie,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    if (!anonymous && response.headers.get("set-cookie"))
      cookie = response.headers.get("set-cookie").split(";")[0];
    return result;
  }
  const page = await fetch(origin + "/login");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="root"><\/div>/);
  const credentials = {
    email: "production@example.test",
    password: "ProductionFixture2026!",
  };
  await request(
    "/setup",
    {
      ...credentials,
      name: "运行成员",
      teamName: "运行团队",
    },
    201,
  );
  await request("/logout", {});
  await request("/login", credentials);
  const project = await request(
    "/projects",
    { name: "运行项目", description: "" },
    201,
  );
  const entry = {
    id: randomUUID(),
    body: "运行依赖提交验证",
    projectId: project.id,
    newTask: { name: "运行任务", description: "" },
  };
  const draft = await request(
    "/diaries",
    { title: "运行日报", entries: [entry] },
    201,
  );
  const submitted = await request(`/diaries/${draft.id}/submit`, {
    version: draft.version,
    requestId: randomUUID(),
  });
  assert.ok(submitted.published.entries[0].taskId);
  const share = await request(
    "/shares",
    {
      type: "diary",
      from: submitted.diaryDate,
      to: submitted.diaryDate,
      modules: ["progress"],
    },
    201,
  );
  const publicResult = await request(
    `/public/${share.token}`,
    undefined,
    200,
    true,
  );
  assert.match(JSON.stringify(publicResult), /运行依赖提交验证/);
  const verifier = randomBytes(32).toString("base64url");
  const authorization = {
    client_id: "daily-flow-codex",
    redirect_uri: "http://127.0.0.1:19999/callback",
    resource: `${origin}/mcp`,
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    scope: "progress:read drafts:write",
    state: "production-fixture",
  };
  const approval = await request(
    "/ai/authorize",
    {
      request: authorization,
      scopes: ["progress:read", "drafts:write"],
      approve: true,
    },
    201,
  );
  const exchange = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: authorization.client_id,
      redirect_uri: authorization.redirect_uri,
      resource: authorization.resource,
      code: new URL(approval.redirect).searchParams.get("code"),
      code_verifier: verifier,
    }),
  });
  assert.equal(exchange.status, 200);
  const token = await exchange.json();
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_draft",
        arguments: {
          operationId: randomUUID(),
          title: "纯运行依赖 MCP",
          entries: [{ id: randomUUID(), body: "真实协议写入" }],
        },
      },
    }),
  });
  assert.equal(response.status, 200);
  const mcp = await response.json();
  assert.ok(!mcp.result.isError, JSON.stringify(mcp));
  assert.equal(
    (await request(`/diaries/${mcp.result.structuredContent.diary.id}`)).draft
      .entries[0].body,
    "真实协议写入",
  );
  console.log(
    "Production-only compiled HTTP/OAuth/MCP runtime passed; tsx, TypeScript and Nest CLI are absent.",
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
}
