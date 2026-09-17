import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { fixture } from "./support.ts";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { request as httpRequest } from "node:http";

test("成员批准能力后以一次性 PKCE 授权码读取自己的 MCP 身份", async (t) => {
  const f = await fixture(t);
  const discovery = await fetch(
    `${f.origin}/.well-known/oauth-protected-resource/mcp`,
  );
  assert.equal(discovery.status, 200);
  assert.equal((await discovery.json()).resource, `${f.origin}/mcp`);
  const verifier = "x".repeat(43);
  const request = {
    client_id: "daily-flow-codex",
    redirect_uri: "http://127.0.0.1:19876/callback",
    resource: `${f.origin}/mcp`,
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    scope: "progress:read drafts:write tasks:write",
    state: "state-123",
  };
  const approval = await f.author("/ai/authorize", {
    request,
    scopes: ["progress:read", "drafts:write"],
    approve: true,
  });
  assert.equal(approval.status, 201);
  const redirect = new URL(approval.data.redirect);
  assert.equal(redirect.searchParams.get("state"), "state-123");
  const exchange = () =>
    fetch(`${f.origin}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: request.client_id,
        redirect_uri: request.redirect_uri,
        resource: request.resource,
        code: redirect.searchParams.get("code")!,
        code_verifier: verifier,
      }),
    });
  const tokenResponse = await exchange();
  assert.equal(tokenResponse.status, 200);
  const token = await tokenResponse.json();
  assert.equal(token.scope, "progress:read drafts:write");
  assert.equal(token.expires_in, 900);
  assert.equal((await exchange()).status, 400);
  const response = await fetch(`${f.origin}/mcp`, {
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
      params: { name: "get_context", arguments: {} },
    }),
  });
  assert.equal(response.status, 200);
  const context = (await response.json()).result.structuredContent;
  assert.equal(context.member.id, f.identity.member.id);
  assert.equal(context.date, "2026-09-16");
  assert.equal(context.timeZone, "Asia/Shanghai");
  assert.equal(context.member.email, undefined);
  const client = new Client({ name: "daily-flow-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${f.origin}/mcp`), {
      requestInit: {
        headers: { Authorization: `Bearer ${token.access_token}` },
      },
    }),
  );
  t.after(() => client.close());
  const listing = await client.listTools();
  assert.ok(listing.tools.some((tool) => tool.name === "get_context"));
  assert.ok(!listing.tools.some((tool) => tool.name === "submit_diary"));
  const result = await client.callTool({ name: "get_context", arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(
    z.object({ date: z.string() }).parse(result.structuredContent).date,
    "2026-09-16",
  );
  const forged = await client.callTool({
    name: "get_context",
    arguments: { memberId: f.other.member.id },
  });
  assert.equal(forged.isError, true);
  f.setTime("2026-09-16T16:15:00Z");
  assert.equal(
    (
      await fetch(`${f.origin}/mcp`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      })
    ).status,
    401,
  );
});

test("授权绑定拒绝错配、取消和外站回调；网页仍只能同源写入", async (t) => {
  const f = await fixture(t),
    verifier = "y".repeat(43);
  const request = {
    client_id: "daily-flow-codex",
    redirect_uri: "http://127.0.0.1:19876/callback",
    resource: `${f.origin}/mcp`,
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    scope: "progress:read",
    state: "valid-state",
  };
  assert.equal(
    (
      await f.guest("/ai/authorize", {
        request,
        scopes: ["progress:read"],
        approve: true,
      })
    ).status,
    401,
  );
  for (const patch of [
    { redirect_uri: "https://evil.test/callback" },
    { client_id: "unknown" },
    { resource: `${f.origin}/api` },
    { code_challenge_method: "plain" },
    { scope: "administrator" },
  ]) {
    assert.equal(
      (
        await f.author("/ai/authorize", {
          request: { ...request, ...patch },
          scopes: ["progress:read"],
          approve: true,
        })
      ).status,
      400,
    );
  }
  const cancelled = (
    await f.author("/ai/authorize", { request, scopes: [], approve: false })
  ).data;
  assert.equal(
    new URL(cancelled.redirect).searchParams.get("error"),
    "access_denied",
  );
  assert.equal(new URL(cancelled.redirect).searchParams.has("code"), false);
  assert.equal(
    (
      await f.author("/ai/authorize", {
        request,
        scopes: ["tasks:write"],
        approve: true,
      })
    ).status,
    400,
  );
  const approval = (
    await f.author("/ai/authorize", {
      request,
      scopes: ["progress:read"],
      approve: true,
    })
  ).data;
  const code = new URL(approval.redirect).searchParams.get("code")!;
  const exchange = (patch: Record<string, string> = {}) =>
    fetch(`${f.origin}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: request.client_id,
        resource: request.resource,
        redirect_uri: request.redirect_uri,
        ...patch,
      }),
    });
  const mismatches: Record<string, string>[] = [
    { client_id: "unknown" },
    { resource: `${f.origin}/api` },
    { redirect_uri: "http://127.0.0.1:9999/callback" },
    { code_verifier: "z".repeat(43) },
  ];
  for (const patch of mismatches)
    assert.equal((await exchange(patch)).status, 400);
  f.setTime("2026-09-16T16:01:00Z");
  assert.equal((await exchange()).status, 400);
  assert.equal(
    (
      await fetch(`${f.origin}/api/diaries`, {
        method: "POST",
        headers: {
          Origin: "https://evil.test",
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${f.origin}/mcp`, {
        headers: { Origin: "https://evil.test" },
      })
    ).status,
    403,
  );
  const hostStatus = await new Promise<number | undefined>(
    (resolve, reject) => {
      const req = httpRequest(
        `${f.origin}/mcp`,
        { headers: { Host: "evil.test" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
  assert.equal(hostStatus, 403);
});
