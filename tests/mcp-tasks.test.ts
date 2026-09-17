import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fixture } from "./support.ts";
import { authorize, mcpClient } from "./mcp-support.ts";
test("AI 独立任务状态更新有真实来源和回执，历史日报快照不变化", async (t) => {
  const f = await fixture(t),
    token = await authorize(f),
    client = await mcpClient(f.origin, token.access_token);
  t.after(() => client.close());
  const project = (
    await f.author("/projects", { name: "任务项目", description: "" })
  ).data;
  const create = await client.callTool({
    name: "create_task",
    arguments: {
      operationId: randomUUID(),
      projectId: project.id,
      name: "独立任务",
      description: "说明",
    },
  });
  assert.ok(!create.isError, JSON.stringify(create));
  const task = JSON.parse(JSON.stringify(create.structuredContent)).task;
  assert.equal(task.status, "pending");
  const diary = (
    await f.author("/diaries", {
      title: "历史",
      entries: [
        {
          id: randomUUID(),
          body: "记录",
          projectId: project.id,
          taskId: task.id,
        },
      ],
    })
  ).data;
  await f.author(`/diaries/${diary.id}/submit`, {
    version: 1,
    requestId: randomUUID(),
  });
  const input = {
    operationId: randomUUID(),
    id: task.id,
    expectedVersion: 1,
    status: "done",
  };
  const result = await client.callTool({
    name: "update_task_status",
    arguments: input,
  });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal(
    JSON.parse(JSON.stringify(result.structuredContent)).task.version,
    2,
  );
  await client.callTool({ name: "update_task_status", arguments: input });
  const events = (await f.author(`/tasks/${task.id}/events`)).data;
  assert.equal(events.length, 1);
  assert.equal(events[0].diaryId, null);
  assert.equal(events[0].kind, "direct");
  assert.equal(events[0].channel, "mcp");
  assert.equal(events[0].member.id, f.identity.member.id);
  assert.equal(
    (await f.author(`/team-diaries/${diary.id}`)).data.published.entries[0]
      .taskStatus,
    "pending",
  );
  const noop = await client.callTool({
    name: "update_task_status",
    arguments: { ...input, operationId: randomUUID(), expectedVersion: 2 },
  });
  assert.equal(
    JSON.parse(JSON.stringify(noop.structuredContent)).changed,
    false,
  );
  const conflict = await client.callTool({
    name: "update_task_status",
    arguments: { ...input, operationId: randomUUID() },
  });
  assert.equal(conflict.isError, true);
  await f.author(`/projects/${project.id}/archive`, { archived: true });
  const archived = await client.callTool({
    name: "update_task_status",
    arguments: {
      ...input,
      operationId: randomUUID(),
      expectedVersion: 2,
      status: "pending",
    },
  });
  assert.equal(archived.isError, true);
});
