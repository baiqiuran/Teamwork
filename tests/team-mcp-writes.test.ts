import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { fixture } from "./support.ts";
import { authorize, mcpClient, allScopes } from "./mcp-support.ts";

async function teams(t: TestContext) {
  const f = await fixture(t);
  const foreign = f.client();
  const outside = await foreign("/setup", {
    teamName: "蓝海团队",
    name: "蓝海成员",
    email: "blue-write@example.test",
    password: "BlueWrite2026!",
  });
  assert.equal(outside.status, 201);
  async function work(client: typeof f.author, prefix: string) {
    const project = (
      await client("/projects", {
        name: `${prefix}项目`,
        description: `${prefix}项目说明`,
      })
    ).data;
    const task = (
      await client(`/projects/${project.id}/tasks`, {
        name: `${prefix}任务`,
        description: `${prefix}任务说明`,
      })
    ).data;
    return { project, task };
  }
  const own = await work(f.author, "青山");
  const ownOther = await work(f.colleague, "青山协作");
  const outsideWork = await work(foreign, "蓝海");
  async function connect(
    client: typeof f.author,
    scopes = allScopes,
    credential: "oauth" | "key" = "oauth",
  ) {
    const token =
      credential === "key"
        ? (await client("/ai/keys", { name: "写入边界验证", scopes })).data.key
        : ((await authorize(f, scopes, client)).access_token as string);
    const mcp = await mcpClient(f.origin, token);
    t.after(() => mcp.close());
    const ok = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await mcp.callTool({ name, arguments: args });
      assert.ok(!result.isError, `${name}: ${JSON.stringify(result)}`);
      return JSON.parse(JSON.stringify(result.structuredContent));
    };
    const refused = async (
      name: string,
      args: Record<string, unknown> = {},
      secrets: string[] = [],
    ) => {
      const result = await mcp.callTool({ name, arguments: args });
      assert.ok(
        result.isError,
        `${name} 不应被允许: ${JSON.stringify(result)}`,
      );
      const text = JSON.stringify(result);
      for (const secret of secrets)
        assert.ok(!text.includes(secret), `${name} 泄露 ${secret}: ${text}`);
      return result;
    };
    return { mcp, token, ok, refused };
  }
  async function snapshot(client: typeof f.author, paths: string[]) {
    const result: Record<string, unknown> = {};
    for (const path of paths) {
      const response = await client(path);
      result[path] = { status: response.status, data: response.data };
    }
    return result;
  }
  return {
    ...f,
    foreign,
    outside: outside.data,
    own,
    ownOther,
    outsideWork,
    connect,
    snapshot,
  };
}

const foreignSecrets = [
  "蓝海项目",
  "蓝海任务",
  "蓝海项目说明",
  "蓝海任务说明",
  "蓝海成员",
];

test("MCP 写入只作用于授权成员本人的本团队对象，跨团队引用失败后无部分写入", async (t) => {
  const f = await teams(t);
  const ai = await f.connect(f.author);
  const entry = {
    id: randomUUID(),
    body: "青山代办工作",
    projectId: f.own.project.id,
    taskId: f.own.task.id,
  };
  const created = await ai.ok("create_draft", {
    operationId: randomUUID(),
    title: "青山代办日报",
    entries: [entry],
  });
  const draftId = created.diary.id as string;
  const badSubmitOperation = randomUUID();
  assert.equal(created.webPath, "/diaries");
  const before = await f.snapshot(f.author, [
    `/diaries/${draftId}`,
    "/diaries/mine",
    `/projects/${f.own.project.id}/tasks`,
    `/tasks/${f.own.task.id}`,
    `/tasks/${f.own.task.id}/events`,
    "/shares",
    "/team-diaries",
  ]);
  const outsideBefore = await f.snapshot(f.foreign, [
    `/projects/${f.outsideWork.project.id}/tasks`,
    `/tasks/${f.outsideWork.task.id}`,
    `/tasks/${f.outsideWork.task.id}/events`,
    "/shares",
  ]);
  // 每次调用都生成新的 operationId，供 OAuth 与成员授权 Key 两种凭据各跑一遍。
  const foreignWrites = (): [string, Record<string, unknown>][] => [
    [
      "update_draft",
      {
        id: draftId,
        expectedVersion: created.diary.version,
        operationId: randomUUID(),
        changes: [
          {
            op: "add",
            entry: {
              id: randomUUID(),
              body: "越权条目",
              projectId: f.outsideWork.project.id,
            },
          },
        ],
      },
    ],
    [
      "update_draft",
      {
        id: draftId,
        expectedVersion: created.diary.version,
        operationId: randomUUID(),
        changes: [
          {
            op: "update",
            id: entry.id,
            fields: { projectId: f.outsideWork.project.id },
          },
        ],
      },
    ],
    [
      "update_draft",
      {
        id: draftId,
        expectedVersion: created.diary.version,
        operationId: randomUUID(),
        changes: [
          {
            op: "update",
            id: entry.id,
            fields: { taskId: f.outsideWork.task.id },
          },
        ],
      },
    ],
    [
      "create_task",
      {
        operationId: randomUUID(),
        projectId: f.outsideWork.project.id,
        name: "越权任务",
        description: "不应创建",
      },
    ],
    [
      "update_task_status",
      {
        operationId: randomUUID(),
        id: f.outsideWork.task.id,
        status: "done",
        expectedVersion: f.outsideWork.task.version,
      },
    ],
    [
      "submit_diary",
      {
        id: draftId,
        expectedVersion: created.diary.version,
        operationId: randomUUID(),
      },
    ],
    [
      "create_share",
      {
        operationId: randomUUID(),
        type: "project",
        targetId: f.outsideWork.project.id,
        from: "2026-09-16",
        to: "2026-09-16",
        modules: ["progress"],
      },
    ],
    [
      "close_share",
      { operationId: randomUUID(), id: f.outsideWork.project.id },
    ],
  ];
  const crossTeam = foreignWrites();
  // submit 前先用非法关联验证阶段校验；随后修正为合法内容再提交。
  for (const [name, args] of crossTeam.filter(
    ([name]) => name !== "submit_diary",
  ))
    await ai.refused(name, args, foreignSecrets);
  assert.deepEqual(await f.snapshot(f.author, Object.keys(before)), before);
  assert.deepEqual(
    await f.snapshot(f.foreign, Object.keys(outsideBefore)),
    outsideBefore,
  );
  // 成员授权 Key 与 OAuth 走同一套团队边界，逐条拒绝且不留下部分写入。
  const keyed = await f.connect(f.author, allScopes, "key");
  for (const [name, args] of foreignWrites()) {
    if (name === "submit_diary") continue;
    await keyed.refused(name, args, foreignSecrets);
  }
  assert.deepEqual(await f.snapshot(f.author, Object.keys(before)), before);
  assert.deepEqual(
    await f.snapshot(f.foreign, Object.keys(outsideBefore)),
    outsideBefore,
  );
  await ai.ok("update_draft", {
    id: draftId,
    expectedVersion: created.diary.version,
    operationId: randomUUID(),
    changes: [
      {
        op: "add",
        entry: {
          id: randomUUID(),
          body: "随日报新建的任务",
          projectId: f.own.project.id,
          newTask: { name: "青山新建任务", description: "由 MCP 代办创建" },
        },
      },
    ],
  });
  const patched = await ai.ok("get_my_draft", { id: draftId, limit: 5 });
  assert.equal(patched.items.length, 2);
  assert.equal(patched.version, created.diary.version + 1);
  const submitted = await ai.ok("submit_diary", {
    id: draftId,
    expectedVersion: patched.version,
    operationId: badSubmitOperation,
  });
  assert.equal(submitted.diary.id, draftId);
  assert.equal(submitted.diary.submittedAt, Date.parse("2026-09-16T15:59:00Z"));
  const replaySubmit = await ai.ok("submit_diary", {
    id: draftId,
    expectedVersion: patched.version,
    operationId: badSubmitOperation,
  });
  assert.equal(replaySubmit.replayed, true, JSON.stringify(replaySubmit));
  assert.deepEqual(replaySubmit.diary, submitted.diary);
  const sameOperationElsewhere = await ai.ok("create_draft", {
    operationId: randomUUID(),
    title: "同标识另一份",
    entries: [{ id: randomUUID(), body: "另一份工作" }],
  });
  await ai.refused("submit_diary", {
    id: sameOperationElsewhere.diary.id,
    expectedVersion: sameOperationElsewhere.diary.version,
    operationId: badSubmitOperation,
  });
  assert.equal(
    (await f.author(`/diaries/${sameOperationElsewhere.diary.id}`)).data
      .published,
    null,
    "重放标识不能提交另一份草稿",
  );
  const published = (await f.author(`/diaries/${draftId}`)).data;
  assert.equal(published.published.entries.length, 2);
  assert.equal(published.published.entries[0].taskStatus, "pending");
  const tasks = (await f.author(`/projects/${f.own.project.id}/tasks`)).data;
  assert.equal(tasks.length, 2);
  const newTask = tasks.find((item: any) => item.name === "青山新建任务");
  assert.deepEqual(
    [newTask.description, newTask.status, newTask.version],
    ["由 MCP 代办创建", "pending", 1],
  );
  assert.equal((await f.author(`/tasks/${newTask.id}/events`)).data.length, 0);
  const status = await ai.ok("update_task_status", {
    operationId: randomUUID(),
    id: f.own.task.id,
    status: "done",
    expectedVersion: f.own.task.version,
  });
  assert.equal(status.task.status, "done");
  assert.equal(status.task.version, 2);
  const events = (await f.author(`/tasks/${f.own.task.id}/events`)).data;
  assert.equal(events.length, 1);
  assert.deepEqual(
    [
      events[0].kind,
      events[0].channel,
      events[0].member.id,
      events[0].before,
      events[0].after,
    ],
    ["direct", "mcp", f.identity.member.id, "pending", "done"],
  );
  const share = await ai.ok("create_share", {
    operationId: randomUUID(),
    type: "project",
    targetId: f.own.project.id,
    from: "2026-09-16",
    to: "2026-09-16",
    modules: ["overview", "progress"],
  });
  assert.equal((await f.guest(`/public/${share.share.token}`)).status, 200);
  await ai.refused(
    "create_share",
    {
      operationId: randomUUID(),
      type: "task",
      targetId: f.outsideWork.task.id,
      from: "2026-09-16",
      to: "2026-09-16",
      modules: ["progress"],
    },
    foreignSecrets,
  );
  const closeOperation = randomUUID();
  const closed = await ai.ok("close_share", {
    operationId: closeOperation,
    id: share.share.id,
  });
  assert.equal(closed.closed, true, JSON.stringify(closed));
  const replayedClose = await ai.ok("close_share", {
    operationId: closeOperation,
    id: share.share.id,
  });
  assert.equal(replayedClose.replayed, true, JSON.stringify(replayedClose));
  assert.equal((await f.guest(`/public/${share.share.token}`)).status, 410);
  assert.equal((await f.foreign(`/team-diaries/${draftId}`)).status, 404);
  assert.equal((await f.foreign(`/tasks/${newTask.id}`)).status, 404);
  assert.deepEqual(
    await f.snapshot(f.foreign, Object.keys(outsideBefore)),
    outsideBefore,
    "跨团队失败不应改变对方对象",
  );
  const history = (await f.author("/ai/operations?limit=20")).data.items;
  const text = JSON.stringify(history);
  for (const secret of foreignSecrets) assert.ok(!text.includes(secret), text);
  assert.ok(!text.includes("dfk_") && !text.includes("access_token"), text);
  assert.equal(
    history.filter((item: any) => item.objectId === draftId).length >= 1,
    true,
  );
  assert.ok(
    new Set(history.map((item: any) => item.memberId ?? "self")).size <= 1,
  );
  assert.deepEqual(
    (await f.colleague("/ai/operations?limit=20")).data.items,
    [],
  );
  assert.deepEqual((await f.foreign("/ai/operations?limit=20")).data.items, []);
});

test("MCP 回执按成员与参数一致隔离，撤销与重启后不能重放他人结果", async (t) => {
  const f = await teams(t);
  const author = await f.connect(f.author, ["progress:read", "tasks:write"]);
  const colleague = await f.connect(f.colleague, [
    "progress:read",
    "tasks:write",
  ]);
  const operationId = randomUUID();
  const first = await author.ok("create_task", {
    operationId,
    projectId: f.own.project.id,
    name: "青山幂等任务",
    description: "只创建一次",
  });
  assert.equal(first.replayed, false, JSON.stringify(first));
  const sameOperation = await colleague.ok("create_task", {
    operationId,
    projectId: f.ownOther.project.id,
    name: "协作幂等任务",
    description: "另一成员同标识",
  });
  assert.notEqual(sameOperation.task.id, first.task.id);
  assert.equal(sameOperation.task.name, "协作幂等任务");
  const replay = await author.ok("create_task", {
    operationId,
    projectId: f.own.project.id,
    name: "青山幂等任务",
    description: "只创建一次",
  });
  assert.deepEqual(replay.task, first.task);
  assert.equal(replay.replayed, true, JSON.stringify(replay));
  assert.equal(
    (await f.author(`/projects/${f.own.project.id}/tasks`)).data.length,
    2,
  );
  const ownOtherTasks = (
    await f.author(`/projects/${f.ownOther.project.id}/tasks`)
  ).data;
  await author.refused("create_task", {
    operationId,
    projectId: f.ownOther.project.id,
    name: "改参数重试",
    description: "不应生效",
  });
  assert.deepEqual(
    (await f.author(`/projects/${f.ownOther.project.id}/tasks`)).data,
    ownOtherTasks,
    "冲突的重试不能在另一成员的项目里留下任务",
  );
  await colleague.refused("create_task", {
    operationId,
    projectId: f.own.project.id,
    name: "青山幂等任务",
    description: "只创建一次",
  });
  const colleagueReplay = await colleague.ok("create_task", {
    operationId,
    projectId: f.ownOther.project.id,
    name: "协作幂等任务",
    description: "另一成员同标识",
  });
  assert.equal(colleagueReplay.replayed, true, JSON.stringify(colleagueReplay));
  assert.deepEqual(colleagueReplay.task, sameOperation.task);
  const authorHistory = JSON.stringify((await f.author("/ai/operations")).data);
  const colleagueHistory = JSON.stringify(
    (await f.colleague("/ai/operations")).data,
  );
  assert.ok(
    authorHistory.includes(f.own.project.id) ||
      authorHistory.includes("青山幂等任务"),
    authorHistory,
  );
  assert.ok(!authorHistory.includes(sameOperation.task.id), authorHistory);
  assert.ok(!colleagueHistory.includes(first.task.id), colleagueHistory);
  const connections = (await f.author("/ai/connections")).data;
  const mine = connections.find((c: any) => c.credentialType === "oauth");
  assert.ok(mine, JSON.stringify(connections));
  assert.equal(
    (await f.author(`/ai/connections/${mine.id}/revoke`, {})).status,
    201,
  );
  const deniedAfterRevoke = async (
    args: Record<string, unknown>,
    stage: string,
  ) => {
    const outcome = await author.mcp
      .callTool({ name: "create_task", arguments: args })
      .catch((error: unknown) => String(error));
    const text = JSON.stringify(outcome);
    assert.ok(
      typeof outcome === "string" || outcome?.isError,
      `${stage} 撤销后仍被允许: ${text}`,
    );
    assert.match(text, /invalid_token|请重新连接|撤销/);
    assert.ok(!text.includes("青山任务说明"), text);
  };
  await deniedAfterRevoke(
    {
      operationId: randomUUID(),
      projectId: f.own.project.id,
      name: "撤销后新建",
      description: "不应生效",
    },
    "撤销后新建",
  );
  await deniedAfterRevoke(
    {
      operationId,
      projectId: f.own.project.id,
      name: "青山幂等任务",
      description: "只创建一次",
    },
    "撤销后重放",
  );
  assert.equal(
    (await f.author(`/projects/${f.own.project.id}/tasks`)).data.length,
    2,
  );
  await f.restart();
  const after = await f.connect(f.colleague, ["progress:read", "tasks:write"]);
  const replayAfterRestart = await after.ok("create_task", {
    operationId,
    projectId: f.ownOther.project.id,
    name: "协作幂等任务",
    description: "另一成员同标识",
  });
  assert.equal(
    replayAfterRestart.replayed,
    true,
    JSON.stringify(replayAfterRestart),
  );
  assert.deepEqual(replayAfterRestart.task, sameOperation.task);
  assert.equal(
    (await f.author(`/projects/${f.own.project.id}/tasks`)).data.length,
    2,
  );
  assert.deepEqual(
    (await f.author(`/projects/${f.ownOther.project.id}/tasks`)).data,
    ownOtherTasks,
  );
});
