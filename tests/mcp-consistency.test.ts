import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fixture } from "./support.ts";
import { authorize, mcpClient } from "./mcp-support.ts";

test("所有写工具并发重试只生效一次，跨成员回执隔离且撤销立即阻断重放", async (t) => {
  const f = await fixture(t),
    token = await authorize(f),
    first = await mcpClient(f.origin, token.access_token),
    second = await mcpClient(f.origin, token.access_token);
  t.after(() => first.close());
  t.after(() => second.close());
  const project = (
    await f.author("/projects", { name: "一致性", description: "" })
  ).data;
  async function repeated(name: string, args: Record<string, unknown>) {
    const results = await Promise.all(
      [first, second].map((c) => c.callTool({ name, arguments: args })),
    );
    const payloads = results.map((r) => {
      assert.ok(!r.isError, JSON.stringify(r));
      return JSON.parse(JSON.stringify(r.structuredContent));
    });
    assert.deepEqual(payloads.map((r) => r.replayed).sort(), [false, true]);
    assert.equal(payloads[0].objectId, payloads[1].objectId);
    assert.equal(payloads[0].executedAt, payloads[1].executedAt);
    return payloads[0];
  }
  const { task } = await repeated("create_task", {
    operationId: randomUUID(),
    projectId: project.id,
    name: "任务",
    description: "",
  });
  const { task: changed } = await repeated("update_task_status", {
    operationId: randomUUID(),
    id: task.id,
    expectedVersion: task.version,
    status: "in-progress",
  });
  const input = {
    operationId: randomUUID(),
    title: "草稿",
    entries: [
      {
        id: randomUUID(),
        body: "正文",
        projectId: project.id,
        taskId: changed.id,
      },
    ],
  };
  let { diary } = await repeated("create_draft", input);
  diary = (
    await repeated("update_draft", {
      operationId: randomUUID(),
      id: diary.id,
      expectedVersion: diary.version,
      title: "更新标题",
      changes: [],
    })
  ).diary;
  const submission = {
    operationId: randomUUID(),
    id: diary.id,
    expectedVersion: diary.version,
  };
  diary = (await repeated("submit_diary", submission)).diary;
  const { share } = await repeated("create_share", {
    operationId: randomUUID(),
    type: "task",
    targetId: task.id,
    from: diary.diaryDate,
    to: diary.diaryDate,
    modules: ["tasks", "progress"],
  });
  assert.equal(
    (await f.guest(`/public/${share.token}`)).data.progress[0].published.entries
      .length,
    1,
  );
  await repeated("close_share", { operationId: randomUUID(), id: share.id });
  assert.equal((await f.guest(`/public/${share.token}`)).status, 410);
  assert.equal((await f.author(`/tasks/${task.id}/events`)).data.length, 1);
  const otherToken = await authorize(f, undefined, f.colleague),
    other = await mcpClient(f.origin, otherToken.access_token);
  t.after(() => other.close());
  const independent = await other.callTool({
    name: "create_draft",
    arguments: input,
  });
  assert.ok(!independent.isError);
  assert.notEqual(
    JSON.parse(JSON.stringify(independent.structuredContent)).diary.id,
    diary.id,
  );
  const crossTool = await first.callTool({
    name: "create_task",
    arguments: {
      operationId: input.operationId,
      projectId: project.id,
      name: "冲突",
      description: "",
    },
  });
  assert.equal(
    JSON.parse(JSON.stringify(crossTool.structuredContent)).error.code,
    "operation-id-conflict",
  );
  const connection = (await f.author("/ai/connections")).data[0];
  await f.author(`/ai/connections/${connection.id}/revoke`, {});
  await assert.rejects(
    first.callTool({ name: "submit_diary", arguments: submission }),
  );
  const fresh = await authorize(f),
    reconnected = await mcpClient(f.origin, fresh.access_token);
  t.after(() => reconnected.close());
  const replay = await reconnected.callTool({
    name: "submit_diary",
    arguments: submission,
  });
  assert.equal(
    JSON.parse(JSON.stringify(replay.structuredContent)).replayed,
    true,
  );
});

test("MCP 首次提交按北京时间跨日归属，历史锁定且分页不能拼接变更前内容", async (t) => {
  const f = await fixture(t),
    token = await authorize(f),
    client = await mcpClient(f.origin, token.access_token);
  t.after(() => client.close());
  async function call(name: string, args: Record<string, unknown>) {
    const r = await client.callTool({ name, arguments: args });
    return JSON.parse(JSON.stringify(r.structuredContent));
  }
  const entry = randomUUID();
  const { diary } = await call("create_draft", {
    operationId: randomUUID(),
    title: "跨日草稿",
    entries: [{ id: entry, body: "长正文".repeat(3000) }],
  });
  const first = await call("get_my_draft", { id: diary.id, limit: 1 });
  assert.ok(first.nextCursor);
  const updated = await call("update_draft", {
    operationId: randomUUID(),
    id: diary.id,
    expectedVersion: 1,
    title: "新标题",
    changes: [],
  });
  assert.equal(
    (
      await call("get_my_draft", {
        id: diary.id,
        limit: 1,
        cursor: first.nextCursor,
      })
    ).error.code,
    "conflict",
  );
  const earlier = await call("create_draft", {
    operationId: randomUUID(),
    title: "昨日提交",
    entries: [{ id: randomUUID(), body: "昨日工作" }],
  });
  await call("submit_diary", {
    operationId: randomUUID(),
    id: earlier.diary.id,
    expectedVersion: 1,
  });
  f.setTime("2026-09-16T16:00:01Z");
  const submitted = await call("submit_diary", {
    operationId: randomUUID(),
    id: diary.id,
    expectedVersion: updated.diary.version,
  });
  assert.equal(submitted.diary.diaryDate, "2026-09-17");
  assert.equal(
    (
      await call("update_draft", {
        operationId: randomUUID(),
        id: earlier.diary.id,
        expectedVersion: 2,
        changes: [],
      })
    ).error.code,
    "history-locked",
  );
  assert.equal(
    (
      await call("submit_diary", {
        operationId: randomUUID(),
        id: earlier.diary.id,
        expectedVersion: 2,
      })
    ).error.code,
    "history-locked",
  );
  assert.equal(
    (
      await call("create_draft", {
        operationId: randomUUID(),
        title: "补写",
        entries: [],
        diaryDate: "2026-09-15",
      })
    ).error.code,
    "invalid",
  );
});

test("默认请求上限容纳最大合法日报，非法附件和超限条目不产生草稿", async (t) => {
  const f = await fixture(t),
    token = await authorize(f),
    client = await mcpClient(f.origin, token.access_token);
  t.after(() => client.close());
  const project = (
    await f.author("/projects", { name: "容量测试", description: "" })
  ).data;
  const entries = Array.from({ length: 50 }, () => ({
    id: randomUUID(),
    body: "\0".repeat(10000),
    projectId: project.id,
    newTask: { name: "待建", description: "\0".repeat(10000) },
  }));
  const result = await client.callTool({
    name: "create_draft",
    arguments: { operationId: randomUUID(), title: "最大草稿", entries },
  });
  assert.ok(!result.isError, JSON.stringify(result));
  for (const invalid of [
    [...entries, entries[0]],
    [{ id: randomUUID(), body: "x".repeat(10001) }],
    [{ id: randomUUID(), body: "附件", attachments: [{ id: randomUUID() }] }],
  ]) {
    const r = await client.callTool({
      name: "create_draft",
      arguments: { operationId: randomUUID(), title: "拒绝", entries: invalid },
    });
    assert.equal(
      JSON.parse(JSON.stringify(r.structuredContent)).error.code,
      "invalid",
    );
  }
  assert.equal((await f.author("/diaries/mine")).data.length, 1);
  assert.equal(
    (await f.author(`/projects/${project.id}/tasks`)).data.length,
    0,
  );
});
