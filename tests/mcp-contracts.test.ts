import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fixture } from "./support.ts";
import { authorize, mcpClient } from "./mcp-support.ts";

test("提交回执完整表达实际任务变化与公开影响，读写输出有 schema", async (t) => {
  const f = await fixture(t),
    token = await authorize(f, ["diaries:submit", "tasks:write"]),
    client = await mcpClient(f.origin, token.access_token);
  t.after(() => client.close());
  const project = (
    await f.author("/projects", { name: "结果契约", description: "" })
  ).data;
  const task = (
    await f.author(`/projects/${project.id}/tasks`, {
      name: "旧任务",
      description: "",
    })
  ).data;
  const draft = (
    await f.author("/diaries", {
      title: "提交",
      entries: [
        {
          id: randomUUID(),
          body: "新任务",
          projectId: project.id,
          newTask: { name: "随提交新建", description: "" },
        },
        {
          id: randomUUID(),
          body: "推进",
          projectId: project.id,
          taskId: task.id,
          statusChange: { status: "done", expectedVersion: 1 },
        },
      ],
    })
  ).data;
  const args = { operationId: randomUUID(), id: draft.id, expectedVersion: 1 };
  const response = await client.callTool({
    name: "submit_diary",
    arguments: args,
  });
  assert.ok(!response.isError, JSON.stringify(response));
  const result = JSON.parse(JSON.stringify(response.structuredContent));
  assert.equal(result.taskEffects.length, 2);
  assert.equal(
    result.taskEffects.find((e: { created: boolean }) => e.created).afterStatus,
    "pending",
  );
  assert.equal(
    result.taskEffects.find((e: { taskId: string }) => e.taskId === task.id)
      .beforeStatus,
    "pending",
  );
  assert.equal(
    result.taskEffects.find((e: { taskId: string }) => e.taskId === task.id)
      .afterStatus,
    "done",
  );
  assert.equal(result.publicImpact.published, true);
  const replay = JSON.parse(
    JSON.stringify(
      (await client.callTool({ name: "submit_diary", arguments: args }))
        .structuredContent,
    ),
  );
  assert.deepEqual(replay.taskEffects, result.taskEffects);
  const list = await client.listTools();
  assert.ok(list.tools.every((tool) => !!tool.outputSchema));
});

test("任务状态与分享关闭筛选绑定分页，校验失败审计和对象入口准确", async (t) => {
  const f = await fixture(t),
    token = await authorize(f),
    client = await mcpClient(f.origin, token.access_token);
  t.after(() => client.close());
  async function call(name: string, args: Record<string, unknown> = {}) {
    const r = await client.callTool({ name, arguments: args });
    return JSON.parse(JSON.stringify(r.structuredContent));
  }
  const project = (
    await f.author("/projects", { name: "筛选", description: "" })
  ).data;
  const { task } = await call("create_task", {
    operationId: randomUUID(),
    projectId: project.id,
    name: "任务",
    description: "",
  });
  const update = await call("update_task_status", {
    operationId: randomUUID(),
    id: task.id,
    expectedVersion: 1,
    status: "done",
  });
  assert.equal(update.beforeStatus, "pending");
  assert.equal(
    (await call("list_tasks", { status: "pending" })).items.length,
    0,
  );
  assert.equal((await call("list_tasks", { status: "done" })).items.length, 1);
  const { share } = await call("create_share", {
    operationId: randomUUID(),
    type: "project",
    targetId: project.id,
    from: "2026-09-16",
    to: "2026-09-16",
    modules: ["progress"],
  });
  await call("close_share", { operationId: randomUUID(), id: share.id });
  assert.equal(
    (await call("list_my_shares", { closed: false })).items.length,
    0,
  );
  assert.equal(
    (await call("list_my_shares", { closed: true })).items.length,
    1,
  );
  const { diary } = await call("create_draft", {
    operationId: randomUUID(),
    title: "满条目",
    entries: Array.from({ length: 50 }, () => ({
      id: randomUUID(),
      body: "已有",
    })),
  });
  const invalid = await call("update_draft", {
    operationId: randomUUID(),
    id: diary.id,
    expectedVersion: 1,
    changes: [{ op: "add", entry: { id: randomUUID(), body: "超限" } }],
  });
  assert.equal(invalid.error.code, "invalid");
  const conflict = await call("update_task_status", {
    operationId: randomUUID(),
    id: task.id,
    expectedVersion: 1,
    status: "pending",
  });
  assert.equal(conflict.error.code, "version-conflict");
  const failures = (await f.author("/ai/operations?outcome=failure")).data
    .items;
  assert.equal(
    failures.find((r: { tool: string }) => r.tool === "update_draft").errorCode,
    "invalid",
  );
  assert.equal(
    failures.find((r: { tool: string }) => r.tool === "update_task_status")
      .objectId,
    task.id,
  );
  assert.ok(
    failures
      .find((r: { tool: string }) => r.tool === "update_task_status")
      .object.url.includes(task.id),
  );
});
