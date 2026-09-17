import assert from "node:assert/strict";
import { test } from "node:test";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./application.ts";
import { fixture } from "./support.ts";
import { authorize } from "./mcp-support.ts";

test("MCP 同时按成员和连接限流，过大请求明确拒绝", async (t) => {
  const f = await fixture(t, {
      mcpMemberLimit: 4,
      mcpGrantLimit: 3,
      mcpMaxBodyBytes: 4194304,
    }),
    first = await authorize(f),
    second = await authorize(f);
  const invoke = (token: string) =>
    fetch(`${f.origin}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_context", arguments: {} },
      }),
    });
  for (let i = 0; i < 3; i++)
    assert.equal((await invoke(first.access_token)).status, 200);
  const grantLimited = await invoke(first.access_token);
  assert.equal(grantLimited.status, 429);
  assert.ok(grantLimited.headers.get("retry-after"));
  assert.equal((await invoke(second.access_token)).status, 200);
  assert.equal((await invoke(second.access_token)).status, 429);
  const oversized = await fetch(`${f.origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "x".repeat(4194304) }),
  });
  assert.equal(oversized.status, 413);
});

test("可信 HTTPS 反向代理保留网页同源和本机初始化限制，协议路由不进入 SPA", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "daily-mcp-proxy-"));
  await writeFile(join(directory, "index.html"), "<html>SPA</html>");
  const app = await createApp({
    databasePath: join(directory, "test.sqlite"),
    setupKey: "proxy-key",
    staticDirectory: directory,
    publicUrl: "https://team.example.test",
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const server = await app.listen(0),
    address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  function request(
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    return new Promise<{
      status: number | undefined;
      headers: import("node:http").IncomingHttpHeaders;
      body: string;
    }>((resolve, reject) => {
      const req = httpRequest(
        `http://127.0.0.1:${port}${path}`,
        {
          method: body ? "POST" : "GET",
          headers: {
            Host: "team.example.test",
            Origin: "https://team.example.test",
            "X-Forwarded-Proto": "https",
            "Content-Type": "application/json",
            ...extra,
          },
        },
        (res) => {
          let result = "";
          res.on("data", (chunk) => (result += chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: result,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  const discovery = await request("/.well-known/oauth-protected-resource/mcp");
  assert.equal(
    JSON.parse(discovery.body).resource,
    "https://team.example.test/mcp",
  );
  for (const path of [
    "/oauth/unknown",
    "/.well-known/unknown",
    "/MCP/unknown",
  ]) {
    const result = await request(path);
    assert.equal(result.status, 404);
    assert.ok(!result.body.includes("SPA"));
  }
  const credentials = {
    name: "代理成员",
    email: "proxy@example.test",
    password: "ProxyFixture2026!",
    teamName: "团队",
    setupKey: "proxy-key",
  };
  assert.equal(
    (
      await request("/api/setup", credentials, {
        "X-Forwarded-For": "203.0.113.4",
      })
    ).status,
    403,
  );
  const setup = await request("/api/setup", credentials, {
    "X-Forwarded-For": "127.0.0.1",
  });
  assert.equal(setup.status, 201);
  assert.match(setup.headers["set-cookie"]?.[0] ?? "", /Secure/);
  assert.equal(
    (await request("/api/logout", {}, { Origin: "https://evil.test" })).status,
    403,
  );
  assert.equal(
    (await request("/mcp", undefined, { Host: "evil.test" })).status,
    403,
  );
  assert.equal((await request("/mcp")).status, 401);
});
