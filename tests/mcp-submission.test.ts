import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fixture } from "./support.ts";
import { authorize, mcpClient } from "./mcp-support.ts";
test("MCP 提交复核已保存草稿的复合权限，原子更新任务和公开内容，重放也需要原能力", async (t) => {
  const f = await fixture(t),
    full = await authorize(f),
    restricted = await authorize(f, ["diaries:submit"]),
    client = await mcpClient(f.origin, full.access_token),
    limited = await mcpClient(f.origin, restricted.access_token);
  t.after(() => client.close());
  t.after(() => limited.close());
  const project = (
    await f.author("/projects", { name: "提交项目", description: "" })
  ).data;
  const task = (
    await f.author(`/projects/${project.id}/tasks`, {
      name: "联调",
      description: "",
    })
  ).data;
  const diary = (
    await f.author("/diaries", {
      title: "完整日报",
      entries: [
        {
          id: randomUUID(),
          body: "已交付",
          projectId: project.id,
          taskId: task.id,
          statusChange: { status: "done", expectedVersion: 1 },
        },
        { id: randomUUID(), body: "临时工作" },
      ],
    })
  ).data;
  const share = (
    await f.author("/shares", {
      type: "diary",
      from: "2026-09-16",
      to: "2026-09-16",
      modules: ["progress", "tasks"],
    })
  ).data;
  const input = { operationId: randomUUID(), id: diary.id, expectedVersion: 1 };
  assert.equal(
    (await limited.callTool({ name: "submit_diary", arguments: input }))
      .isError,
    true,
  );
  assert.equal((await f.author(`/diaries/${diary.id}`)).data.published, null);
  const submitted = await client.callTool({
    name: "submit_diary",
    arguments: input,
  });
  assert.ok(!submitted.isError, JSON.stringify(submitted));
  const published = (await f.guest(`/public/${share.token}`)).data;
  assert.equal(published.progress[0].published.entries.length, 2);
  assert.equal(published.tasks[0].status, "done");
  const events = (await f.author(`/tasks/${task.id}/events`)).data;
  assert.equal(events[0].kind, "diary");
  assert.equal(events[0].channel, "mcp");
  assert.equal(
    (await limited.callTool({ name: "submit_diary", arguments: input }))
      .isError,
    true,
  );
  const replay = await client.callTool({
    name: "submit_diary",
    arguments: input,
  });
  assert.equal(
    JSON.parse(JSON.stringify(replay.structuredContent)).replayed,
    true,
  );
  const conflict = (
    await f.author("/diaries", {
      title: "整体回滚",
      entries: [
        {
          id: randomUUID(),
          body: "拟建任务",
          projectId: project.id,
          newTask: { name: "不能留下", description: "" },
        },
        {
          id: randomUUID(),
          body: "旧状态",
          projectId: project.id,
          taskId: task.id,
          statusChange: { status: "pending", expectedVersion: 1 },
        },
      ],
    })
  ).data;
  assert.equal(
    (
      await client.callTool({
        name: "submit_diary",
        arguments: {
          operationId: randomUUID(),
          id: conflict.id,
          expectedVersion: 1,
        },
      })
    ).isError,
    true,
  );
  assert.equal(
    (await f.author(`/projects/${project.id}/tasks`)).data.length,
    1,
  );
  assert.equal(
    (await f.author(`/diaries/${conflict.id}`)).data.published,
    null,
  );
});
