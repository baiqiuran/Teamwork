import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { fixture } from "./support.ts";
import { authorize, mcpClient } from "./mcp-support.ts";

const shared = "同名共享项目";
const ownSecrets = [
  "青山项目说明",
  "青山任务",
  "青山已提交工作",
  "青山成员",
  "青山日报",
  "周宁",
  "lin@example.test",
  "zhou@example.test",
];
const foreignSecrets = [
  "蓝海项目说明",
  "蓝海任务",
  "蓝海已提交工作",
  "蓝海成员",
  "蓝海日报",
  "blue-mcp@example.test",
];

async function teams(t: TestContext) {
  const f = await fixture(t);
  const foreign = f.client();
  const outside = await foreign("/setup", {
    teamName: "蓝海团队",
    name: "蓝海成员",
    email: "blue-mcp@example.test",
    password: "BlueMcp2026!",
  });
  assert.equal(outside.status, 201);
  async function work(client: typeof f.author, prefix: string, name: string) {
    const project = (
      await client("/projects", { name, description: `${prefix}项目说明` })
    ).data;
    const task = (
      await client(`/projects/${project.id}/tasks`, {
        name: `${prefix}任务`,
        description: `${prefix}任务说明`,
      })
    ).data;
    const entry = {
      id: randomUUID(),
      body: `${prefix}已提交工作`,
      projectId: project.id,
      taskId: task.id,
      statusChange: { status: "in-progress", expectedVersion: task.version },
    };
    const draft = (
      await client("/diaries", { title: `${prefix}日报`, entries: [entry] })
    ).data;
    const uploaded = (
      await client(`/diaries/${draft.id}/entries/${entry.id}/attachments`, {
        version: draft.version,
        requestId: randomUUID(),
        name: `${prefix}附件.txt`,
        base64: Buffer.from(`${prefix}附件字节`).toString("base64"),
      })
    ).data;
    const diary = (
      await client(`/diaries/${draft.id}/submit`, {
        version: uploaded.version,
        requestId: randomUUID(),
      })
    ).data;
    assert.equal(diary.published.entries[0].taskStatus, "in-progress");
    return {
      project,
      task,
      diary,
      file: uploaded.draft.entries[0].attachments[0] as {
        id: string;
        name: string;
        size: number;
      },
    };
  }
  const own = await work(f.author, "青山", shared);
  const outsideWork = await work(foreign, "蓝海", shared);
  async function credentials(client: typeof f.author, name: string) {
    const oauth = await authorize(f, ["progress:read"], client);
    const issued = await client("/ai/keys", {
      name,
      scopes: ["progress:read"],
    });
    assert.equal(issued.status, 201, JSON.stringify(issued.data));
    return {
      oauth: oauth.access_token as string,
      key: issued.data.key as string,
    };
  }
  return {
    ...f,
    foreign,
    outside: outside.data,
    own,
    outsideWork,
    credentials,
  };
}

async function tools(origin: string, token: string, t: TestContext) {
  const client = await mcpClient(origin, token);
  t.after(() => client.close());
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result)}`);
    return JSON.parse(JSON.stringify(result.structuredContent));
  };
  const refused = async (
    name: string,
    args: Record<string, unknown> = {},
    secrets: string[] = [],
  ) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(result.isError, `${name} 不应被允许: ${JSON.stringify(result)}`);
    const text = JSON.stringify(result);
    for (const secret of secrets)
      assert.ok(!text.includes(secret), `${name} 泄露了 ${secret}`);
    return result;
  };
  return { client, ok, refused };
}

test("两类 MCP 凭据只查询授权成员所属团队，同名候选、详情与事件都不带出对方内容", async (t) => {
  const f = await teams(t);
  const inside = await f.credentials(f.author, "青山只读");
  const outsider = await f.credentials(f.foreign, "蓝海只读");
  const ownIds = [f.own.project.id, f.own.task.id, f.own.diary.id];
  const foreignIds = [
    f.outsideWork.project.id,
    f.outsideWork.task.id,
    f.outsideWork.diary.id,
  ];
  for (const [label, token] of [
    ["OAuth", inside.oauth],
    ["成员 Key", inside.key],
  ] as const) {
    const api = await tools(f.origin, token, t);
    const members = await api.ok("list_members", { limit: 10 });
    // MCP 候选按标识排序，成员名单页才按姓名排序；两者都只含本团队成员。
    assert.deepEqual(
      members.items.map((m: any) => m.name).sort(),
      ["周宁", "林晓"],
    );
    assert.deepEqual(
      members.items.map((m: any) => Object.keys(m).sort()),
      [
        ["id", "name"],
        ["id", "name"],
      ],
      `${label} 成员查询不应返回邮箱或团队字段`,
    );
    assert.equal(members.total, 2);
    const candidates = await api.ok("list_projects", {
      query: shared,
      limit: 5,
    });
    assert.deepEqual(
      candidates.items.map((p: any) => p.id),
      [f.own.project.id],
    );
    assert.equal(candidates.total, 1, `${label} 同名候选只能命中本团队项目`);
    assert.equal(candidates.items[0].detailTool, "get_project");
    assert.equal(
      (await api.ok("get_project", { id: f.own.project.id })).description,
      "青山项目说明",
    );
    const tasks = await api.ok("list_tasks", {
      projectId: f.own.project.id,
      limit: 5,
    });
    assert.deepEqual(
      tasks.items.map((x: any) => x.name),
      ["青山任务"],
    );
    const task = await api.ok("get_task", { id: f.own.task.id });
    assert.equal(task.status, "in-progress");
    assert.equal(task.version, 2);
    const events = await api.ok("list_task_events", {
      id: f.own.task.id,
      limit: 5,
    });
    assert.equal(events.total, 1);
    assert.deepEqual(events.items[0].member, {
      id: f.identity.member.id,
      name: "林晓",
    });
    assert.deepEqual(
      [events.items[0].before, events.items[0].after, events.items[0].kind],
      ["pending", "in-progress", "diary"],
    );
    const progress = await api.ok("query_progress", {
      projectId: f.own.project.id,
      limit: 5,
    });
    assert.deepEqual(
      progress.items.map((x: any) => x.id),
      [f.own.diary.id],
    );
    assert.equal(progress.items[0].excerpt, "青山已提交工作");
    const list = await api.ok("list_diaries", {
      from: "2026-09-16",
      to: "2026-09-16",
      limit: 5,
    });
    assert.deepEqual(
      list.items.map((x: any) => x.id),
      [f.own.diary.id],
    );
    assert.equal(list.range.from, "2026-09-16");
    const diary = await api.ok("get_diary", { id: f.own.diary.id, limit: 5 });
    assert.equal(diary.items[0].body, "青山已提交工作");
    assert.equal(diary.items[0].taskStatusAtSubmission, "in-progress");
    assert.deepEqual(diary.items[0].attachments, [f.own.file]);
    assert.deepEqual(diary.author, { id: f.identity.member.id, name: "林晓" });
    for (const id of foreignIds) {
      await api.refused("get_project", { id }, foreignSecrets);
      await api.refused("get_task", { id }, foreignSecrets);
      await api.refused(
        "list_tasks",
        { projectId: id, limit: 5 },
        foreignSecrets,
      );
      await api.refused("list_task_events", { id, limit: 5 }, foreignSecrets);
      await api.refused(
        "query_progress",
        { projectId: id, limit: 5 },
        foreignSecrets,
      );
      await api.refused(
        "query_progress",
        { taskId: id, limit: 5 },
        foreignSecrets,
      );
      await api.refused("get_diary", { id, limit: 5 }, foreignSecrets);
    }
    await api.refused(
      "list_diaries",
      { memberId: f.outside.member.id, limit: 5 },
      foreignSecrets,
    );
    await api.refused(
      "query_progress",
      { projectId: f.own.project.id, taskId: f.outsideWork.task.id, limit: 5 },
      foreignSecrets,
    );
    const after = JSON.stringify(
      await Promise.all([
        api.ok("list_projects", { limit: 10 }),
        api.ok("list_diaries", {
          from: "2026-09-16",
          to: "2026-09-16",
          limit: 10,
        }),
      ]),
    );
    assert.ok(!foreignSecrets.some((secret) => after.includes(secret)), after);
  }
  for (const token of [outsider.oauth, outsider.key]) {
    const api = await tools(f.origin, token, t);
    const candidates = await api.ok("list_projects", {
      query: shared,
      limit: 5,
    });
    assert.deepEqual(
      candidates.items.map((p: any) => p.id),
      [f.outsideWork.project.id],
    );
    const members = await api.ok("list_members", { limit: 10 });
    assert.deepEqual(
      members.items.map((m: any) => m.name),
      ["蓝海成员"],
    );
    for (const id of ownIds) {
      await api.refused("get_project", { id }, ownSecrets);
      await api.refused("get_task", { id }, ownSecrets);
      await api.refused("get_diary", { id, limit: 5 }, ownSecrets);
      await api.refused("list_task_events", { id, limit: 5 }, ownSecrets);
      await api.refused(
        "query_progress",
        { projectId: id, limit: 5 },
        ownSecrets,
      );
    }
    await api.refused(
      "list_diaries",
      { memberId: f.identity.member.id, limit: 5 },
      ownSecrets,
    );
  }
});

test("MCP 分页游标绑定成员、工具与筛选条件，跨团队或改条件不能续读", async (t) => {
  const f = await teams(t);
  for (const name of [
    "青山补充项目一",
    "青山补充项目二",
    "青山补充项目三",
    "青山补充项目四",
  ])
    assert.equal(
      (await f.author("/projects", { name, description: "" })).status,
      201,
    );
  assert.equal(
    (await f.foreign("/projects", { name: "蓝海补充项目", description: "" }))
      .status,
    201,
  );
  const inside = await f.credentials(f.author, "青山分页");
  const outsider = await f.credentials(f.foreign, "蓝海分页");
  const author = await tools(f.origin, inside.oauth, t);
  const first = await author.ok("list_projects", { limit: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(first.total, 5);
  assert.equal(typeof first.nextCursor, "string");
  const second = await author.ok("list_projects", {
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.equal(
    new Set([...first.items, ...second.items].map((p: any) => p.id)).size,
    4,
  );
  const third = await author.ok("list_projects", {
    limit: 2,
    cursor: second.nextCursor,
  });
  assert.equal(third.items.length, 1);
  assert.equal(third.nextCursor, null);
  await author.refused("list_projects", { limit: 2, cursor: "not-a-cursor" });
  await author.refused("list_projects", {
    limit: 2,
    cursor: `${first.nextCursor}f`,
  });
  await author.refused("list_projects", {
    limit: 2,
    query: "补充",
    cursor: first.nextCursor,
  });
  await author.refused("list_tasks", { limit: 2, cursor: first.nextCursor });
  await author.refused("list_diaries", { limit: 2, cursor: first.nextCursor });
  const outsiderApi = await tools(f.origin, outsider.oauth, t);
  const foreignFirst = await outsiderApi.ok("list_projects", { limit: 2 });
  assert.equal(foreignFirst.total, 2);
  await outsiderApi.refused(
    "list_projects",
    { limit: 2, cursor: first.nextCursor },
    ownSecrets,
  );
  await author.refused(
    "list_projects",
    { limit: 2, cursor: foreignFirst.nextCursor },
    foreignSecrets,
  );
  const unchanged = await author.ok("list_projects", { limit: 2 });
  assert.deepEqual(
    unchanged.items.map((p: any) => p.id),
    first.items.map((p: any) => p.id),
  );
});

test("MCP 连接列表、Key 创建与撤销仍是本人操作，他人和别队不能读取或撤销", async (t) => {
  const f = await teams(t);
  const issued = await f.author("/ai/keys", {
    name: "青山待撤销",
    scopes: ["progress:read"],
  });
  assert.equal(issued.status, 201);
  const key = issued.data.key as string;
  const connections = await f.author("/ai/connections");
  assert.equal(connections.status, 200);
  const mine = connections.data.filter((c: any) => c.name === "青山待撤销");
  assert.equal(mine.length, 1);
  assert.ok(!JSON.stringify(connections.data).includes("dfk_"));
  const reader = await tools(f.origin, key, t);
  assert.equal((await reader.ok("list_projects", { limit: 5 })).total, 1);
  for (const [client, label] of [
    [f.colleague, "同团队他人"],
    [f.foreign, "外队成员"],
  ] as const) {
    const seen = await client("/ai/connections");
    assert.equal(seen.status, 200, label);
    const text = JSON.stringify(seen.data);
    assert.ok(!text.includes("青山待撤销"), `${label} 不应看到他人连接名`);
    assert.ok(!text.includes(mine[0].id), `${label} 不应看到他人连接标识`);
    const denied = await client(`/ai/connections/${mine[0].id}/revoke`, {});
    assert.ok(
      [403, 404].includes(denied.status),
      `${label}: ${JSON.stringify(denied.data)}`,
    );
    assert.deepEqual(
      Object.keys(denied.data).sort(),
      ["error", "error_description"],
      label,
    );
    assert.ok(!JSON.stringify(denied.data).includes("青山"), label);
  }
  assert.equal((await reader.ok("list_projects", { limit: 5 })).total, 1);
  const revoked = await f.author(`/ai/connections/${mine[0].id}/revoke`, {});
  assert.ok([200, 201].includes(revoked.status), JSON.stringify(revoked.data));
  const refused = async (stage: string) => {
    const failure = await reader.client
      .callTool({ name: "list_projects", arguments: { limit: 5 } })
      .then(() => null, (error: unknown) => String(error));
    assert.ok(failure, `${stage} 撤销后仍被允许`);
    assert.match(failure, /invalid_token/);
    for (const secret of ownSecrets)
      assert.ok(!failure.includes(secret), `${stage} 泄露 ${secret}`);
    await assert.rejects(mcpClient(f.origin, key), /invalid_token|Unauthorized/);
  };
  await refused("撤销后");
  const after = await f.author("/ai/connections");
  assert.equal(after.status, 200);
  assert.ok(
    after.data.every(
      (c: any) => c.name !== "青山待撤销" || c.revokedAt !== null,
    ),
    JSON.stringify(after.data),
  );
  await f.restart();
  await refused("重启后");
});
