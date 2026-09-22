import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { fixture } from "./support.ts";
import type { Diary } from "../src/shared/contracts.ts";

async function teams(t: TestContext) {
  const f = await fixture(t);
  const second = f.client();
  const registered = await second("/setup", {
    teamName: "第二团队",
    name: "第二队成员",
    email: "second@example.test",
    password: "SecondTeam2026!",
  });
  assert.equal(registered.status, 201);
  const work = [];
  for (const [client, name] of [
    [f.author, "第一队"],
    [second, "第二队"],
  ] as const) {
    const project = await client("/projects", {
      name: `${name}项目`,
      description: `${name}项目说明`,
      teamId: registered.data.team.id,
    });
    assert.equal(project.status, 201);
    const task = await client(`/projects/${project.data.id}/tasks`, {
      name: `${name}任务`,
      description: `${name}任务说明`,
    });
    assert.equal(task.status, 201);
    work.push({ project: project.data, task: task.data });
  }
  return {
    ...f,
    second,
    secondIdentity: registered.data,
    a: work[0],
    b: work[1],
  };
}

test("项目任务列表及已知标识读取限定团队，筛选参数不能覆盖会话身份", async (t) => {
  const f = await teams(t);
  for (const [client, own, foreign, teamId] of [
    [f.author, f.a, f.b, f.secondIdentity.team.id],
    [f.second, f.b, f.a, f.identity.team.id],
  ] as const) {
    const projects = await client(`/projects?teamId=${teamId}`);
    assert.equal(projects.status, 200);
    assert.deepEqual(projects.data, [own.project]);
    assert.deepEqual((await client(`/projects/${own.project.id}/tasks`)).data, [
      own.task,
    ]);
    assert.deepEqual(
      (await client(`/projects/${own.project.id}`)).data,
      own.project,
    );
    assert.deepEqual((await client(`/tasks/${own.task.id}`)).data, own.task);
    assert.deepEqual((await client(`/tasks/${own.task.id}/events`)).data, []);
    for (const path of [
      `/projects/${foreign.project.id}`,
      `/projects/${foreign.project.id}/tasks`,
      `/projects/${foreign.project.id}/progress`,
      `/tasks/${foreign.task.id}`,
      `/tasks/${foreign.task.id}/progress`,
      `/tasks/${foreign.task.id}/events`,
    ]) {
      const denied = await client(`${path}?teamId=${teamId}`);
      assert.equal(denied.status, 404, path);
      assert.deepEqual(Object.keys(denied.data), ["error"]);
      assert.doesNotMatch(JSON.stringify(denied.data), /第一队|第二队/);
    }
  }
  assert.deepEqual(
    (await f.colleague(`/projects/${f.a.project.id}/tasks`)).data,
    [f.a.task],
  );
  await f.restart();
  assert.deepEqual((await f.author("/projects")).data, [f.a.project]);
  assert.deepEqual((await f.second("/projects")).data, [f.b.project]);
});

test("跨团队创建编辑归档恢复均无部分结果，同队仍只有创建者可改资料", async (t) => {
  const f = await teams(t);
  const shareInput = {
    from: "2026-09-16",
    to: "2026-09-16",
    modules: ["overview", "tasks", "progress"],
  };
  const shares = [];
  for (const [client, own] of [
    [f.author, f.a],
    [f.second, f.b],
  ] as const) {
    const made = [];
    for (const [type, targetId] of [
      ["project", own.project.id],
      ["task", own.task.id],
      ["diary", undefined],
    ] as const) {
      const result = await client("/shares", { ...shareInput, type, targetId });
      assert.equal(result.status, 201);
      made.push(result.data);
    }
    shares.push(made);
  }
  for (const [client, foreign, owner] of [
    [f.author, f.b, f.second],
    [f.second, f.a, f.author],
  ] as const) {
    const before = {
      project: (await owner(`/projects/${foreign.project.id}`)).data,
      task: (await owner(`/tasks/${foreign.task.id}`)).data,
      events: (await owner(`/tasks/${foreign.task.id}/events`)).data,
      tasks: (await owner(`/projects/${foreign.project.id}/tasks`)).data,
      shares: (await owner("/shares")).data,
    };
    for (const [path, body] of [
      [
        `/projects/${foreign.project.id}/tasks`,
        {
          name: "错误归属",
          description: "",
          createdBy: foreign.project.creator.id,
        },
      ],
      [
        `/projects/${foreign.project.id}/save`,
        { name: "被改项目", description: "" },
      ],
      [`/tasks/${foreign.task.id}/save`, { name: "被改任务", description: "" }],
      [`/projects/${foreign.project.id}/archive`, { archived: true }],
      [`/tasks/${foreign.task.id}/archive`, { archived: true }],
      [`/projects/${foreign.project.id}/archive`, { archived: false }],
      [`/tasks/${foreign.task.id}/archive`, { archived: false }],
    ] as const) {
      const response = await client(path, body);
      assert.equal(response.status, 404, path);
      assert.deepEqual(Object.keys(response.data), ["error"]);
    }
    assert.deepEqual(
      {
        project: (await owner(`/projects/${foreign.project.id}`)).data,
        task: (await owner(`/tasks/${foreign.task.id}`)).data,
        events: (await owner(`/tasks/${foreign.task.id}/events`)).data,
        tasks: (await owner(`/projects/${foreign.project.id}/tasks`)).data,
        shares: (await owner("/shares")).data,
      },
      before,
    );
  }
  for (const path of [`/projects/${f.a.project.id}`, `/tasks/${f.a.task.id}`]) {
    assert.equal(
      (await f.colleague(`${path}/save`, { name: "同队篡改", description: "" }))
        .status,
      403,
    );
    assert.equal(
      (await f.colleague(`${path}/archive`, { archived: true })).status,
      403,
    );
    assert.equal(
      (
        await f.author(`${path}/save`, {
          name: "本人改名",
          description: "更新说明",
        })
      ).status,
      200,
    );
  }
  const collaborative = await f.colleague(`/projects/${f.a.project.id}/tasks`, {
    name: "同队协作任务",
    description: "",
  });
  assert.equal(collaborative.status, 201);
  assert.equal(collaborative.data.creator.id, f.other.member.id);
  assert.equal(
    (await f.author(`/projects/${f.a.project.id}/archive`, { archived: true }))
      .status,
    200,
  );
  for (const share of shares[0].slice(0, 2))
    assert.equal((await f.guest(`/public/${share.token}`)).status, 410);
  assert.equal((await f.guest(`/public/${shares[0][2].token}`)).status, 200);
  for (const share of shares[1])
    assert.equal((await f.guest(`/public/${share.token}`)).status, 200);
  assert.equal(
    (
      await f.author(`/projects/${f.a.project.id}/tasks`, {
        name: "归档后创建",
        description: "",
      })
    ).status,
    409,
  );
  assert.equal(
    (await f.author(`/projects/${f.a.project.id}/archive`, { archived: false }))
      .status,
    200,
  );
  assert.equal(
    (await f.second(`/tasks/${f.b.task.id}/archive`, { archived: true }))
      .status,
    200,
  );
  assert.equal((await f.guest(`/public/${shares[1][1].token}`)).status, 410);
  assert.equal((await f.guest(`/public/${shares[1][0].token}`)).status, 200);
  assert.equal(
    (await f.second(`/tasks/${f.b.task.id}/archive`, { archived: false }))
      .status,
    200,
  );
  await f.restart();
  for (const share of [shares[0][0], shares[0][1], shares[1][1]])
    assert.equal((await f.guest(`/public/${share.token}`)).status, 410);
  assert.equal(
    (await f.author(`/projects/${f.a.project.id}`)).data.archived,
    false,
  );
  assert.equal((await f.second(`/tasks/${f.b.task.id}`)).data.archived, false);
});

test("项目任务进展先限定日报作者团队再投影，公开范围来自分享生成者", async (t) => {
  const f = await teams(t);
  const published: Diary[] = [];
  for (const [client, own, label, status] of [
    [f.author, f.a, "第一队", "done"],
    [f.second, f.b, "第二队", "in-progress"],
  ] as const) {
    const draft = await client("/diaries", {
      title: `${label}完整标题`,
      entries: [
        {
          id: randomUUID(),
          body: `${label}任务进展`,
          projectId: own.project.id,
          taskId: own.task.id,
          statusChange: { status, expectedVersion: 1 },
        },
        {
          id: randomUUID(),
          body: `${label}项目临时工作`,
          projectId: own.project.id,
        },
        { id: randomUUID(), body: `${label}未关联工作` },
      ],
    });
    assert.equal(draft.status, 201);
    const submitted = await client(`/diaries/${draft.data.id}/submit`, {
      version: 1,
      requestId: randomUUID(),
    });
    assert.equal(submitted.status, 200);
    published.push(submitted.data);
  }
  const colleagueDraft = await f.colleague("/diaries", {
    title: "同队成员",
    entries: [
      { id: randomUUID(), body: "同队补充", projectId: f.a.project.id },
    ],
  });
  assert.equal(
    (
      await f.colleague(`/diaries/${colleagueDraft.data.id}/submit`, {
        version: 1,
        requestId: randomUUID(),
      })
    ).status,
    200,
  );
  for (const [client, own, foreign, label, otherLabel, diary, member] of [
    [f.author, f.a, f.b, "第一队", "第二队", published[0], f.identity.member],
    [
      f.second,
      f.b,
      f.a,
      "第二队",
      "第一队",
      published[1],
      f.secondIdentity.member,
    ],
  ] as const) {
    const progress = await client(`/projects/${own.project.id}/progress`);
    assert.equal(progress.status, 200);
    assert.equal(progress.data.length, label === "第一队" ? 2 : 1);
    const ownRecord = progress.data.find(
      (row: { id: string }) => row.id === diary.id,
    );
    assert.equal(ownRecord.published.entries.length, 2);
    assert.deepEqual(ownRecord.author, { id: member.id, name: member.name });
    assert.doesNotMatch(
      JSON.stringify(progress.data),
      new RegExp(`${otherLabel}|完整标题|未关联工作|email`),
    );
    const taskProgress = await client(`/tasks/${own.task.id}/progress`);
    assert.equal(taskProgress.data.length, 1);
    assert.equal(taskProgress.data[0].published.entries.length, 1);
    assert.equal(
      taskProgress.data[0].published.entries[0].body,
      `${label}任务进展`,
    );
    const events = await client(`/tasks/${own.task.id}/events`);
    assert.equal(events.status, 200);
    assert.equal(events.data.length, 1);
    assert.deepEqual(events.data[0].member, {
      id: member.id,
      name: member.name,
    });
    assert.equal(events.data[0].diaryId, diary.id);
    assert.equal(events.data[0].kind, "diary");
    assert.equal(events.data[0].channel, "web");
    assert.equal(events.data[0].before, "pending");
    assert.equal(
      events.data[0].after,
      label === "第一队" ? "done" : "in-progress",
    );
    assert.deepEqual(
      (
        await client(
          `/projects/${own.project.id}/progress?from=2026-09-15&to=2026-09-15`,
        )
      ).data,
      [],
    );
    assert.deepEqual(
      (await client(`/team-diaries?projectId=${foreign.project.id}`)).data,
      [],
    );
    assert.doesNotMatch(
      JSON.stringify((await client("/team-diaries")).data),
      new RegExp(otherLabel),
    );
  }
  const saved = await f.author(`/diaries/${published[0].id}/save`, {
    ...published[0].draft,
    version: published[0].version,
    entries: published[0].draft.entries.map((entry: { body: string }) => ({
      ...entry,
      body: "未重新提交内容",
    })),
  });
  assert.equal(saved.status, 200);
  for (const [type, targetId, entryCount, diaryCount] of [
    ["project", f.a.project.id, 3, 2],
    ["task", f.a.task.id, 1, 1],
    ["diary", undefined, 4, 2],
  ] as const) {
    const made = await f.colleague("/shares", {
      type,
      targetId,
      from: "2026-09-16",
      to: "2026-09-16",
      modules: ["overview", "tasks", "progress"],
    });
    assert.equal(made.status, 201);
    for (const viewer of [f.guest, f.second]) {
      const result = await viewer(
        `/public/${made.data.token}?teamId=${f.secondIdentity.team.id}`,
      );
      assert.equal(result.status, 200);
      assert.equal(result.data.overview.entryCount, entryCount);
      assert.equal(result.data.overview.diaryCount, diaryCount);
      assert.equal(result.data.overview.taskCount, 1);
      assert.equal(result.data.tasks.length, 1);
      assert.equal(result.data.tasks[0].id, f.a.task.id);
      assert.equal(result.data.tasks[0].status, "done");
      assert.doesNotMatch(
        JSON.stringify(result.data),
        /第二队|未重新提交内容|email/,
      );
      const original = result.data.progress.find(
        (row: { id: string }) => row.id === published[0].id,
      );
      assert.equal(original.published.entries[0].body, "第一队任务进展");
      assert.equal(original.published.entries[0].taskStatus, "done");
    }
  }
});

test("删除已提交日报仍保留同团队任务状态记录，外队不能读取保留历史", async (t) => {
  const f = await teams(t);
  const created = await f.author("/diaries", {
    title: "稍后删除",
    entries: [
      {
        id: randomUUID(),
        body: "完成工作",
        projectId: f.a.project.id,
        taskId: f.a.task.id,
        statusChange: { status: "done", expectedVersion: 1 },
      },
    ],
  });
  assert.equal(created.status, 201);
  const submitted = await f.author(`/diaries/${created.data.id}/submit`, {
    version: 1,
    requestId: randomUUID(),
  });
  assert.equal(submitted.status, 200);
  const before = (await f.colleague(`/tasks/${f.a.task.id}/events`)).data;
  assert.equal(before.length, 1);
  assert.equal(before[0].diaryId, created.data.id);
  assert.equal(
    (
      await f.author(`/diaries/${created.data.id}/delete`, {
        version: submitted.data.version,
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.colleague(`/team-diaries/${created.data.id}`)).status,
    404,
  );
  assert.deepEqual(
    (await f.colleague(`/tasks/${f.a.task.id}/events`)).data,
    before,
  );
  assert.equal((await f.author(`/tasks/${f.a.task.id}`)).data.status, "done");
  assert.equal((await f.second(`/tasks/${f.a.task.id}/events`)).status, 404);
  await f.restart();
  assert.deepEqual(
    (await f.colleague(`/tasks/${f.a.task.id}/events`)).data,
    before,
  );
});
