import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./support.ts";
import { authorize } from "./mcp-support.ts";

test("授权持续有效、凭证轮换且网页撤销仅影响本人的指定连接", async (t) => {
  const f = await fixture(t),
    first = await authorize(f),
    second = await authorize(f);
  assert.equal(typeof first.refresh_token, "string");
  const refresh = (
    token: string,
    client = "daily-flow-codex",
    resource = `${f.origin}/mcp`,
  ) =>
    fetch(`${f.origin}/oauth/token`, {
      method: "POST",
      headers: { Connection: "close" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client,
        resource,
        refresh_token: token,
      }),
    });
  f.setTime("2027-01-16T01:00:00Z");
  assert.equal(
    (
      await fetch(`${f.origin}/mcp`, {
        headers: {
          Connection: "close",
          Authorization: `Bearer ${first.access_token}`,
        },
      })
    ).status,
    401,
  );
  assert.equal(
    (await refresh(first.refresh_token, "other-client")).status,
    400,
  );
  assert.equal(
    (
      await refresh(
        first.refresh_token,
        "daily-flow-codex",
        `${f.origin}/wrong`,
      )
    ).status,
    400,
  );
  const refreshed = await refresh(first.refresh_token);
  assert.equal(refreshed.status, 200);
  const current = await refreshed.json();
  assert.notEqual(current.refresh_token, first.refresh_token);
  assert.equal((await refresh(first.refresh_token)).status, 400);
  await f.author("/login", {
    email: f.credentials.email,
    password: f.credentials.password,
  });
  const connections = (await f.author("/ai/connections")).data;
  assert.equal(connections.length, 2);
  const active = connections.find(
    (c: { lastUsedAt: number; createdAt: number }) =>
      c.lastUsedAt > c.createdAt,
  );
  assert.ok(active);
  await f.colleague("/login", {
    email: "zhou@example.test",
    password: f.credentials.password,
  });
  assert.deepEqual((await f.colleague("/ai/connections")).data, []);
  assert.equal(
    (await f.colleague(`/ai/connections/${active.id}/revoke`, {})).status,
    404,
  );
  assert.equal(
    (await f.author(`/ai/connections/${active.id}/revoke`, {})).status,
    201,
  );
  assert.equal(
    (await f.author(`/ai/connections/${active.id}/delete`, {})).status,
    200,
  );
  assert.equal((await f.author("/ai/connections")).data.length, 1);
  assert.equal(
    (
      await fetch(`${f.origin}/mcp`, {
        headers: {
          Connection: "close",
          Authorization: `Bearer ${current.access_token}`,
        },
      })
    ).status,
    401,
  );
  assert.equal((await refresh(current.refresh_token)).status, 400);
  await f.restart();
  assert.equal((await refresh(current.refresh_token)).status, 400);
  assert.equal((await refresh(second.refresh_token)).status, 200);
  assert.equal((await f.author("/me")).status, 200);
});
