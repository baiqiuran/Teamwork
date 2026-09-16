import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fixture } from "./support.ts";

test("任务仅创建者编辑定义，日报可引用或随提交新建，非法关联回滚全部结果", async (t) => {
  const f = await fixture(t);
  const p = (await f.author("/projects", { name: "产品", description: "" }))
    .data;
  const q = (await f.author("/projects", { name: "网站", description: "" }))
    .data;
  const created = await f.author(`/projects/${p.id}/tasks`, {
    name: "登录",
    description: "原始说明",
  });
  assert.equal(created.status, 201);
  const task = created.data;
  assert.equal(task.status, "pending");
  assert.equal(
    (
      await f.colleague(`/tasks/${task.id}/save`, {
        name: "篡改",
        description: "",
      })
    ).status,
    403,
  );
  const entries = [
    { id: randomUUID(), body: "协作进展", projectId: p.id, taskId: task.id },
    {
      id: randomUUID(),
      body: "新增内容",
      projectId: p.id,
      newTask: { name: "新事项", description: "" },
    },
    { id: randomUUID(), body: "临时工作", projectId: p.id },
  ];
  const d = (await f.colleague("/diaries", { title: "协作", entries })).data;
  assert.equal((await f.author(`/projects/${p.id}/tasks`)).data.length, 1);
  const input = { version: 1, requestId: randomUUID() };
  const result = await f.colleague(`/diaries/${d.id}/submit`, input);
  assert.equal(result.status, 200);
  const submitted = result.data;
  assert.equal(submitted.published.entries[0].taskStatus, "pending");
  assert.equal((await f.author(`/tasks/${task.id}`)).data.status, "pending");
  assert.equal(
    (await f.author(`/tasks/${task.id}/progress`)).data[0].published.entries
      .length,
    1,
  );
  assert.equal((await f.author(`/projects/${p.id}/tasks`)).data.length, 2);
  await f.colleague(`/diaries/${d.id}/submit`, input);
  assert.equal((await f.author(`/projects/${p.id}/tasks`)).data.length, 2);
  const bad = (
    await f.author("/diaries", {
      title: "",
      entries: [
        {
          id: randomUUID(),
          body: "先创建",
          projectId: p.id,
          newTask: { name: "不该留下", description: "" },
        },
        {
          id: randomUUID(),
          body: "跨项目引用",
          projectId: q.id,
          taskId: task.id,
        },
      ],
    })
  ).data;
  assert.equal(
    (
      await f.author(`/diaries/${bad.id}/submit`, {
        version: 1,
        requestId: randomUUID(),
      })
    ).status,
    400,
  );
  assert.equal((await f.author(`/projects/${p.id}/tasks`)).data.length, 2);
  assert.equal((await f.colleague(`/team-diaries/${bad.id}`)).status, 404);
});

test("明确变更任务状态留下操作者，冲突整份不提交，保留最新与强制目标均重验版本", async (t) => {
  const f = await fixture(t);
  const p = (await f.author("/projects", { name: "产品", description: "" }))
    .data;
  const task = (
    await f.author(`/projects/${p.id}/tasks`, { name: "登录", description: "" })
  ).data;
  async function draft(
    client: typeof f.author,
    status: string,
    version: number,
  ) {
    return (
      await client("/diaries", {
        title: status,
        entries: [
          {
            id: randomUUID(),
            body: "工作",
            projectId: p.id,
            taskId: task.id,
            statusChange: { status, expectedVersion: version },
          },
        ],
      })
    ).data;
  }
  const a = await draft(f.author, "in-progress", 1);
  const b = await draft(f.colleague, "done", 1);
  const pa = (
    await f.author(`/diaries/${a.id}/submit`, {
      version: a.version,
      requestId: randomUUID(),
    })
  ).data;
  assert.equal(
    (await f.author(`/tasks/${task.id}`)).data.status,
    "in-progress",
  );
  const conflict = await f.colleague(`/diaries/${b.id}/submit`, {
    version: b.version,
    requestId: randomUUID(),
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.details.conflicts[0].latestStatus, "in-progress");
  assert.equal((await f.author(`/team-diaries/${b.id}`)).status, 404);
  const latestVersion = conflict.data.details.conflicts[0].latestVersion;
  const keepEntries = b.draft.entries.map((e: object) => ({
    ...e,
    statusChange: {
      status: "done",
      expectedVersion: latestVersion,
      resolution: "keep",
    },
  }));
  const kept = (
    await f.colleague(`/diaries/${b.id}/save`, {
      version: b.version,
      title: "",
      entries: keepEntries,
    })
  ).data;
  const pb = (
    await f.colleague(`/diaries/${b.id}/submit`, {
      version: kept.version,
      requestId: randomUUID(),
    })
  ).data;
  assert.equal(pb.published.entries[0].taskStatus, "in-progress");
  const c = await draft(f.colleague, "done", latestVersion);
  const pc = (
    await f.colleague(`/diaries/${c.id}/submit`, {
      version: 1,
      requestId: randomUUID(),
    })
  ).data;
  assert.equal(pc.published.entries[0].taskStatus, "done");
  assert.equal(
    (await f.author(`/team-diaries/${a.id}`)).data.published.entries[0]
      .taskStatus,
    "in-progress",
  );
  const textOnly = (
    await f.author(`/diaries/${a.id}/save`, {
      ...pa.draft,
      title: "仅修改文字",
      version: pa.version,
    })
  ).data;
  await f.author(`/diaries/${a.id}/submit`, {
    version: textOnly.version,
    requestId: randomUUID(),
  });
  assert.equal((await f.author(`/tasks/${task.id}`)).data.status, "done");
  const events = (await f.author(`/tasks/${task.id}/events`)).data;
  assert.equal(events.length, 2);
  assert.equal(events[0].member.name, "林晓");
  assert.equal(events[0].before, "pending");
  assert.equal(events[0].after, "in-progress");
  assert.equal(events[1].member.name, "周宁");
  const old = await draft(f.author, "pending", latestVersion);
  assert.equal(
    (
      await f.author(`/diaries/${old.id}/submit`, {
        version: 1,
        requestId: randomUUID(),
      })
    ).status,
    409,
  );
});

test("空的新任务可暂存草稿，提交前要求名称完整", async (t) => {
  const f = await fixture(t);
  const p = (await f.author("/projects", { name: "A", description: "" })).data;
  const draft = await f.author("/diaries", {
    title: "",
    entries: [
      {
        id: randomUUID(),
        body: "工作",
        projectId: p.id,
        newTask: { name: "", description: "" },
      },
    ],
  });
  assert.equal(draft.status, 201);
  assert.equal(
    (
      await f.author(`/diaries/${draft.data.id}/submit`, {
        version: 1,
        requestId: randomUUID(),
      })
    ).status,
    400,
  );
  assert.equal((await f.author(`/projects/${p.id}/tasks`)).data.length, 0);
});

test("多个任务提交遇到冲突不部分更新，冲突选择后再变动仍拒绝，重复目标必须统一", async (t) => {
  const f = await fixture(t),
    p = (await f.author("/projects", { name: "A", description: "" })).data;
  const a = (
    await f.author(`/projects/${p.id}/tasks`, { name: "A", description: "" })
  ).data;
  const b = (
    await f.author(`/projects/${p.id}/tasks`, { name: "B", description: "" })
  ).data;
  async function change(id: string, status: string, expectedVersion: number) {
    const d = (
      await f.colleague("/diaries", {
        title: "更新",
        entries: [
          {
            id: randomUUID(),
            body: "工作",
            projectId: p.id,
            taskId: id,
            statusChange: { status, expectedVersion },
          },
        ],
      })
    ).data;
    return f.colleague(`/diaries/${d.id}/submit`, {
      version: 1,
      requestId: randomUUID(),
    });
  }
  const entries = [a, b].map((task) => ({
    id: randomUUID(),
    body: "工作",
    projectId: p.id,
    taskId: task.id,
    statusChange: { status: "done", expectedVersion: 1 },
  }));
  let d = (await f.author("/diaries", { title: "原子提交", entries })).data;
  await change(b.id, "in-progress", 1);
  assert.equal(
    (
      await f.author(`/diaries/${d.id}/submit`, {
        version: 1,
        requestId: randomUUID(),
      })
    ).status,
    409,
  );
  assert.equal((await f.author(`/tasks/${a.id}`)).data.status, "pending");
  entries[1].statusChange.expectedVersion = 2;
  d = (
    await f.author(`/diaries/${d.id}/save`, {
      title: "原子提交",
      entries,
      version: 1,
    })
  ).data;
  await change(b.id, "pending", 2);
  assert.equal(
    (
      await f.author(`/diaries/${d.id}/submit`, {
        version: d.version,
        requestId: randomUUID(),
      })
    ).status,
    409,
  );
  assert.equal((await f.author(`/tasks/${a.id}/events`)).data.length, 0);
  const divergent = (
    await f.author("/diaries", {
      title: "不一致",
      entries: [
        entries[0],
        {
          ...entries[0],
          id: randomUUID(),
          statusChange: { status: "in-progress", expectedVersion: 1 },
        },
      ],
    })
  ).data;
  assert.equal(
    (
      await f.author(`/diaries/${divergent.id}/submit`, {
        version: 1,
        requestId: randomUUID(),
      })
    ).status,
    400,
  );
  assert.equal((await f.author(`/tasks/${a.id}`)).data.status, "pending");
});
