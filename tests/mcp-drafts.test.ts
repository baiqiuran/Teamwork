import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { fixture } from "./support.ts";
import { authorize, mcpClient } from "./mcp-support.ts";

test("AI 默认新建本人草稿，重试与重新授权不重复写入，非法关联不落库", async (t) => {
  const f = await fixture(t),
    token = await authorize(f, ["drafts:write"]);
  let client = await mcpClient(f.origin, token.access_token);
  t.after(() => client.close());
  const input = {
    operationId: randomUUID(),
    title: "AI 草稿",
    entries: [{ id: randomUUID(), body: "临时工作" }],
  };
  const result = await client.callTool({
    name: "create_draft",
    arguments: input,
  });
  assert.ok(!result.isError, JSON.stringify(result));
  const created = JSON.parse(JSON.stringify(result.structuredContent));
  assert.equal(created.replayed, false);
  const webpage = await f.author(`/diaries/${created.diary.id}`);
  assert.equal(webpage.data.draft.title, "AI 草稿");
  assert.equal(webpage.data.published, null);
  assert.equal((await f.colleague(`/diaries/${created.diary.id}`)).status, 404);
  const duplicate = await client.callTool({
    name: "create_draft",
    arguments: input,
  });
  assert.equal(
    JSON.parse(JSON.stringify(duplicate.structuredContent)).replayed,
    true,
  );
  const conflict = await client.callTool({
    name: "create_draft",
    arguments: { ...input, title: "不同内容" },
  });
  assert.equal(conflict.isError, true);
  assert.equal(
    JSON.parse(JSON.stringify(conflict.structuredContent)).error.code,
    "operation-id-conflict",
  );
  await client.close();
  await f.restart();
  const reauthorized = await authorize(f, ["drafts:write"]);
  client = await mcpClient(f.origin, reauthorized.access_token);
  const replay = await client.callTool({
    name: "create_draft",
    arguments: input,
  });
  assert.equal(
    JSON.parse(JSON.stringify(replay.structuredContent)).diary.id,
    created.diary.id,
  );
  assert.equal((await f.author("/diaries/mine")).data.length, 1);
  const invalid = await client.callTool({
    name: "create_draft",
    arguments: {
      ...input,
      operationId: randomUUID(),
      entries: [{ id: randomUUID(), body: "工作", projectId: randomUUID() }],
    },
  });
  assert.equal(invalid.isError, true);
  assert.equal((await f.author("/diaries/mine")).data.length, 1);
  const history = (await f.author("/ai/operations")).data;
  assert.equal(
    history.items.filter(
      (row: { outcome: string }) => row.outcome === "success",
    ).length,
    1,
  );
  assert.equal(
    history.items.filter((row: { outcome: string }) => row.outcome === "replay")
      .length,
    2,
  );
  assert.ok(!JSON.stringify(history).includes("临时工作"));
  assert.equal((await f.colleague("/ai/operations")).data.items.length, 0);
  const malformed = await client.callTool({
    name: "create_draft",
    arguments: {
      ...input,
      operationId: randomUUID(),
      authorId: f.identity.member.id,
    },
  });
  assert.equal(malformed.isError, true);
  assert.equal(
    JSON.parse(JSON.stringify(malformed.structuredContent)).error.code,
    "invalid",
  );
  const failures = (await f.author("/ai/operations?outcome=failure")).data
    .items;
  assert.ok(
    failures.some(
      (row: { tool: string; errorCode: string }) =>
        row.tool === "create_draft" && row.errorCode === "invalid",
    ),
  );
});

test("AI 按条目补充保留未指定内容、附件与版本冲突，历史提交不可改", async (t) => {
  const f = await fixture(t),
    token = await authorize(f, ["drafts:write"]),
    client = await mcpClient(f.origin, token.access_token);
  t.after(() => client.close());
  const entry = randomUUID(),
    other = randomUUID();
  const diary = (
    await f.author("/diaries", {
      title: "原文",
      entries: [
        { id: entry, body: "第一条" },
        { id: other, body: "保留条目" },
      ],
    })
  ).data;
  const upload = await f.author(
    `/diaries/${diary.id}/entries/${other}/attachments`,
    {
      version: 1,
      requestId: randomUUID(),
      name: "说明.txt",
      base64: Buffer.from("附件").toString("base64"),
    },
  );
  assert.equal(upload.status, 201, JSON.stringify(upload.data));
  const saved = (await f.author(`/diaries/${diary.id}`)).data;
  const result = await client.callTool({
    name: "update_draft",
    arguments: {
      operationId: randomUUID(),
      id: diary.id,
      expectedVersion: saved.version,
      changes: [{ op: "update", id: entry, fields: { body: "补充内容" } }],
    },
  });
  assert.ok(!result.isError, JSON.stringify(result));
  const updated = (await f.author(`/diaries/${diary.id}`)).data;
  assert.equal(updated.draft.title, "原文");
  assert.deepEqual(updated.draft.entries[1], saved.draft.entries[1]);
  assert.equal(updated.draft.entries[0].body, "补充内容");
  const stale = await client.callTool({
    name: "update_draft",
    arguments: {
      operationId: randomUUID(),
      id: diary.id,
      expectedVersion: saved.version,
      title: "旧版本覆盖",
      changes: [],
    },
  });
  assert.equal(stale.isError, true);
  const remove = await client.callTool({
    name: "update_draft",
    arguments: {
      operationId: randomUUID(),
      id: diary.id,
      expectedVersion: updated.version,
      changes: [{ op: "remove", id: other }],
    },
  });
  assert.equal(remove.isError, true);
  assert.equal(
    (await f.author(`/diaries/${diary.id}`)).data.version,
    updated.version,
  );
  await f.author(`/diaries/${diary.id}/submit`, {
    version: updated.version,
    requestId: randomUUID(),
  });
  f.setTime("2026-09-16T16:00:00Z");
  const locked = await client.callTool({
    name: "update_draft",
    arguments: {
      operationId: randomUUID(),
      id: diary.id,
      expectedVersion: updated.version + 1,
      title: "补写",
      changes: [],
    },
  });
  assert.equal(locked.isError, true);
});
