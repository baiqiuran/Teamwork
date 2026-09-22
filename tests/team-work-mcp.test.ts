import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fixture } from "./support.ts";
import { authorize, mcpClient } from "./mcp-support.ts";

test("MCP 项目任务限定授权成员的团队，已知外团队标识不能读取或更新状态", async (t) => {
  const f = await fixture(t);
  const foreign = f.client();
  const joined = await foreign("/setup", {
    name: "外团队成员",
    email: "foreign-work@example.test",
    password: "QuietRiver2026!",
    teamName: "外团队",
  });
  assert.equal(joined.status, 201);
  assert.notEqual(joined.data.team.id, f.identity.team.id);
  const project = (
    await f.author("/projects", { name: "本团队项目", description: "本团队" })
  ).data;
  const foreignProject = (
    await foreign("/projects", { name: "外团队项目", description: "外团队" })
  ).data;
  const foreignTask = (
    await foreign(`/projects/${foreignProject.id}/tasks`, {
      name: "外团队任务",
      description: "不可修改",
    })
  ).data;
  const token = await authorize(f, ["progress:read", "tasks:write"]);
  const client = await mcpClient(f.origin, token.access_token);
  t.after(() => client.close());
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  const accepted = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await call(name, args);
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(JSON.stringify(result.structuredContent));
  };
  const { task } = await accepted("create_task", {
    operationId: randomUUID(),
    projectId: project.id,
    name: "本团队任务",
    description: "允许修改",
  });
  assert.equal(
    (await accepted("get_project", { id: project.id })).id,
    project.id,
  );
  assert.equal((await accepted("get_task", { id: task.id })).id, task.id);
  const updated = await accepted("update_task_status", {
    operationId: randomUUID(),
    id: task.id,
    expectedVersion: task.version,
    status: "done",
  });
  assert.equal(updated.task.status, "done");
  assert.equal(updated.task.version, task.version + 1);
  const ownEvents = await accepted("list_task_events", { id: task.id });
  assert.equal(ownEvents.total, 1);
  assert.equal(ownEvents.items[0].member.id, f.identity.member.id);
  assert.equal(ownEvents.items[0].kind, "direct");
  assert.equal(ownEvents.items[0].channel, "mcp");

  const before = {
    task: (await foreign(`/tasks/${foreignTask.id}`)).data,
    events: (await foreign(`/tasks/${foreignTask.id}/events`)).data,
    tasks: (await foreign(`/projects/${foreignProject.id}/tasks`)).data,
  };
  const projects = await accepted("list_projects", { limit: 1 });
  const tasks = await accepted("list_tasks", { limit: 1 });
  const ownTasks = await accepted("list_tasks", { projectId: project.id });
  const denied: Record<string, unknown> = {};
  for (const [name, args] of [
    ["get_project", { id: foreignProject.id }],
    ["get_task", { id: foreignTask.id }],
    ["list_tasks", { projectId: foreignProject.id }],
    ["list_task_events", { id: foreignTask.id }],
    ["query_progress", { projectId: foreignProject.id }],
    ["query_progress", { taskId: foreignTask.id }],
    [
      "create_task",
      {
        operationId: randomUUID(),
        projectId: foreignProject.id,
        name: "禁止跨团队创建",
        description: "",
      },
    ],
    [
      "update_task_status",
      {
        operationId: randomUUID(),
        id: foreignTask.id,
        expectedVersion: foreignTask.version,
        status: "done",
      },
    ],
  ] as const) {
    const result = await call(name, args);
    const label =
      name === "query_progress"
        ? `${name}:${"taskId" in args ? "task" : "project"}`
        : name;
    denied[label] = {
      isError: result.isError === true,
      notFound: JSON.stringify(result).includes("not-found"),
    };
  }
  const after = {
    task: (await foreign(`/tasks/${foreignTask.id}`)).data,
    events: (await foreign(`/tasks/${foreignTask.id}/events`)).data,
    tasks: (await foreign(`/projects/${foreignProject.id}/tasks`)).data,
  };
  assert.deepEqual(denied, {
    get_project: { isError: true, notFound: true },
    get_task: { isError: true, notFound: true },
    list_tasks: { isError: true, notFound: true },
    list_task_events: { isError: true, notFound: true },
    "query_progress:project": { isError: true, notFound: true },
    "query_progress:task": { isError: true, notFound: true },
    create_task: { isError: true, notFound: true },
    update_task_status: { isError: true, notFound: true },
  });
  assert.deepEqual(after, before);
  for (const [page, id] of [
    [projects, project.id],
    [tasks, task.id],
    [ownTasks, task.id],
  ] as const) {
    assert.deepEqual(
      page.items.map((item: { id: string }) => item.id),
      [id],
    );
    assert.equal(page.total, 1);
    assert.equal(page.nextCursor, null);
  }
});
