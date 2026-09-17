import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fixture } from "./support.ts";
import { authorize, mcpClient } from "./mcp-support.ts";
test("AI 必须明确分享范围，团队日报包含所有成员；仅本人关闭且回执重放不重开", async (t) => {
  const f = await fixture(t),
    token = await authorize(f, ["shares:manage"]),
    client = await mcpClient(f.origin, token.access_token);
  t.after(() => client.close());
  for (const owner of [f.author, f.colleague]) {
    const diary = (
      await owner("/diaries", {
        title: "日报",
        entries: [{ id: randomUUID(), body: "成员工作" }],
      })
    ).data;
    await owner(`/diaries/${diary.id}/submit`, {
      version: 1,
      requestId: randomUUID(),
    });
  }
  const input = {
    operationId: randomUUID(),
    type: "diary",
    from: "2026-09-16",
    to: "2026-09-16",
    modules: ["progress"],
  };
  const invalid = await client.callTool({
    name: "create_share",
    arguments: { operationId: randomUUID(), type: "diary" },
  });
  assert.equal(invalid.isError, true);
  const result = await client.callTool({
    name: "create_share",
    arguments: input,
  });
  assert.ok(!result.isError, JSON.stringify(result));
  const share = JSON.parse(JSON.stringify(result.structuredContent)).share;
  assert.equal(new URL(share.url).origin, f.origin);
  assert.equal(
    (await f.guest(`/public/${share.token}`)).data.progress.length,
    2,
  );
  const otherToken = await authorize(f, ["shares:manage"], f.colleague),
    other = await mcpClient(f.origin, otherToken.access_token);
  t.after(() => other.close());
  assert.equal(
    (
      await other.callTool({
        name: "close_share",
        arguments: { operationId: randomUUID(), id: share.id },
      })
    ).isError,
    true,
  );
  const close = await client.callTool({
    name: "close_share",
    arguments: { operationId: randomUUID(), id: share.id },
  });
  assert.ok(!close.isError, JSON.stringify(close));
  await client.callTool({ name: "create_share", arguments: input });
  assert.equal((await f.guest(`/public/${share.token}`)).status, 410);
  assert.equal((await f.author("/shares")).data.length, 1);
});
