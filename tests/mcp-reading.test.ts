import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { fixture } from "./support.ts";
import { authorize, mcpClient } from "./mcp-support.ts";

test("MCP 查询同名候选、完整日报与项目投影，分页不泄露私人补充", async (t) => {
  const f = await fixture(t),
    token = await authorize(f, ["progress:read"]),
    client = await mcpClient(f.origin, token.access_token);
  t.after(() => client.close());
  const p1 = (
    await f.author("/projects", { name: "同名项目", description: "甲" })
  ).data;
  await f.colleague("/projects", { name: "同名项目", description: "乙" });
  const diary = (
    await f.author("/diaries", {
      title: "完整记录",
      entries: [
        { id: randomUUID(), body: "项目进度".repeat(1500), projectId: p1.id },
        { id: randomUUID(), body: "临时工作" },
      ],
    })
  ).data;
  await f.author(`/diaries/${diary.id}/submit`, {
    version: 1,
    requestId: randomUUID(),
  });
  assert.equal(
    (
      await f.author(`/diaries/${diary.id}/save`, {
        version: 2,
        title: "私人补充",
        entries: [{ id: randomUUID(), body: "不能公开的草稿" }],
      })
    ).status,
    200,
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, JSON.stringify(r));
    return JSON.parse(JSON.stringify(r.structuredContent));
  };
  const projects = await call("list_projects", { query: "同名", limit: 1 });
  assert.equal(projects.items.length, 1);
  assert.ok(projects.nextCursor);
  const next = await call("list_projects", {
    query: "同名",
    limit: 1,
    cursor: projects.nextCursor,
  });
  assert.notEqual(projects.items[0].id, next.items[0].id);
  assert.equal(next.nextCursor, null);
  const list = await call("list_diaries", { projectId: p1.id });
  assert.equal(list.items.length, 1);
  assert.deepEqual(list.range, { from: "2026-09-16", to: "2026-09-16" });
  assert.equal(list.items[0].entryCount, 2);
  assert.equal(list.items[0].summary, true);
  let detail = await call("get_diary", { id: diary.id, limit: 1 });
  const segments = [...detail.items];
  while (detail.nextCursor) {
    detail = await call("get_diary", {
      id: diary.id,
      limit: 1,
      cursor: detail.nextCursor,
    });
    segments.push(...detail.items);
  }
  assert.equal(
    segments.map((item) => item.body).join(""),
    "项目进度".repeat(1500) + "临时工作",
  );
  assert.ok(!JSON.stringify(detail).includes("私人补充"));
  const projected = await call("query_progress", { projectId: p1.id });
  assert.equal(projected.items[0].entryCount, 1);
  const hiddenToken = await authorize(f, ["drafts:write"]),
    hidden = await mcpClient(f.origin, hiddenToken.access_token);
  t.after(() => hidden.close());
  assert.ok(
    !(await hidden.listTools()).tools.some(
      (tool) => tool.name === "list_diaries",
    ),
  );
  await assert.rejects(() =>
    hidden.callTool({ name: "list_diaries", arguments: {} }),
  );
});
