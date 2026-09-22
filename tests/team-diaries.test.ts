import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { fixture } from "./support.ts";

async function teams(t: TestContext) {
  const f = await fixture(t);
  const foreign = f.client();
  const identity = await foreign("/setup", {
    teamName: "蓝海团队",
    name: "蓝海成员",
    email: "blue-diary@example.test",
    password: "BlueDiary2026!",
  });
  assert.equal(identity.status, 201);
  async function work(client: typeof f.author, name: string) {
    const project = await client("/projects", {
      name: `${name}项目`,
      description: name,
    });
    assert.equal(project.status, 201);
    const task = await client(`/projects/${project.data.id}/tasks`, {
      name: `${name}任务`,
      description: name,
    });
    assert.equal(task.status, 201);
    return { project: project.data, task: task.data };
  }
  return {
    ...f,
    foreign,
    foreignIdentity: identity.data,
    own: await work(f.author, "青山"),
    outside: await work(foreign, "蓝海"),
  };
}

test("草稿创建保存拒绝外队项目任务，失败不持久化且不提前执行同队提交规则", async (t) => {
  const f = await teams(t);
  for (const [client, own, outside] of [
    [f.author, f.own, f.outside],
    [f.foreign, f.outside, f.own],
  ] as const) {
    const valid = {
      id: randomUUID(),
      body: "应保留",
      projectId: own.project.id,
      taskId: own.task.id,
    };
    const created = await client("/diaries", {
      title: "原稿",
      entries: [valid],
    });
    assert.equal(created.status, 201);
    const before = (await client("/diaries/mine")).data;
    const associations = [
      { projectId: outside.project.id },
      { projectId: outside.project.id, taskId: outside.task.id },
      { projectId: own.project.id, taskId: outside.task.id },
      { taskId: outside.task.id },
      {
        projectId: outside.project.id,
        newTask: { name: "不能创建", description: "" },
      },
    ];
    for (const association of associations) {
      const input = {
        title: "不得保存",
        entries: [
          valid,
          { id: randomUUID(), body: "越权引用", ...association },
        ],
      };
      const rejected = await client("/diaries", input);
      assert.equal(rejected.status, 404);
      assert.deepEqual(Object.keys(rejected.data), ["error"]);
      const saved = await client(`/diaries/${created.data.id}/save`, {
        ...input,
        version: created.data.version,
      });
      assert.equal(saved.status, 404);
      assert.deepEqual((await client("/diaries/mine")).data, before);
      assert.deepEqual(
        (await client(`/diaries/${created.data.id}`)).data,
        created.data,
      );
    }
    const other = await client("/projects", {
      name: "同队另一项目",
      description: "",
    });
    assert.equal(other.status, 201);
    const incomplete = await client(`/diaries/${created.data.id}/save`, {
      version: created.data.version,
      title: "暂存未完成关联",
      entries: [
        { ...valid, projectId: other.data.id },
        {
          id: randomUUID(),
          body: "名称稍后填写",
          projectId: own.project.id,
          newTask: { name: "", description: "" },
        },
      ],
    });
    assert.equal(incomplete.status, 200);
    const rejected = await client(`/diaries/${created.data.id}/submit`, {
      version: incomplete.data.version,
      requestId: randomUUID(),
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(
      (await client(`/diaries/${created.data.id}`)).data,
      incomplete.data,
    );
  }
  await f.restart();
  assert.deepEqual(
    (await f.author(`/projects/${f.own.project.id}/tasks`)).data,
    [f.own.task],
  );
  assert.deepEqual(
    (await f.foreign(`/projects/${f.outside.project.id}/tasks`)).data,
    [f.outside.task],
  );
});

test("两队日报按首次提交日期读取，私有修改、回执和删除结果不跨成员复用", async (t) => {
  const f = await teams(t);
  const requestId = randomUUID();
  const work = [];
  for (const [client, identity, objects, name] of [
    [f.author, f.identity, f.own, "青山"],
    [f.foreign, f.foreignIdentity, f.outside, "蓝海"],
  ] as const) {
    const created = await client("/diaries", {
      title: `${name}日报`,
      entries: [
        {
          id: randomUUID(),
          body: `${name}完整正文`,
          projectId: objects.project.id,
        },
      ],
    });
    assert.equal(created.status, 201);
    work.push({ client, identity, objects, name, draft: created.data });
  }
  f.setTime("2026-09-16T16:01:00Z");
  const published = [];
  for (const item of work) {
    const submitInput = { version: item.draft.version, requestId };
    const response = await item.client(
      `/diaries/${item.draft.id}/submit`,
      submitInput,
    );
    assert.equal(response.status, 200);
    assert.equal(response.data.diaryDate, "2026-09-17");
    assert.equal(
      response.data.firstSubmittedAt,
      Date.parse("2026-09-16T16:01:00Z"),
    );
    assert.deepEqual(
      (await item.client(`/diaries/${item.draft.id}/submit`, submitInput)).data,
      response.data,
    );
    const saved = await item.client(`/diaries/${item.draft.id}/save`, {
      version: response.data.version,
      title: `${item.name}私密修改`,
      entries: [
        { ...response.data.draft.entries[0], body: `${item.name}尚未重提` },
      ],
    });
    assert.equal(saved.status, 200);
    published.push({
      ...item,
      submitted: response.data,
      saved: saved.data,
      submitInput,
    });
  }
  for (const [own, outside] of [
    [published[0], published[1]],
    [published[1], published[0]],
  ]) {
    const list = await own.client(
      "/team-diaries?from=2026-09-17&to=2026-09-17",
    );
    assert.equal(list.status, 200);
    assert.equal(list.data.length, 1);
    assert.deepEqual(list.data[0].published, own.submitted.published);
    assert.deepEqual(list.data[0].author, {
      id: own.identity.member.id,
      name: own.identity.member.name,
    });
    assert.equal("draft" in list.data[0], false);
    assert.doesNotMatch(
      JSON.stringify(list.data),
      new RegExp(`${outside.name}|私密修改|尚未重提`),
    );
    for (const filter of [
      "from=2026-09-16&to=2026-09-16",
      `memberId=${outside.identity.member.id}`,
      `projectId=${outside.objects.project.id}`,
    ])
      assert.deepEqual(
        (await own.client(`/team-diaries?${filter}`)).data,
        [],
        filter,
      );
    assert.deepEqual(
      (
        await own.client(
          `/team-diaries?taskId=${outside.objects.task.id}&teamId=${outside.identity.team.id}`,
        )
      ).data,
      list.data,
    );
    assert.deepEqual(
      (await own.client(`/team-diaries?memberId=${own.identity.member.id}`))
        .data,
      list.data,
    );
    for (const path of [
      `/diaries/${outside.draft.id}`,
      `/team-diaries/${outside.draft.id}`,
    ]) {
      const denied = await own.client(path);
      assert.equal(denied.status, 404);
      assert.deepEqual(Object.keys(denied.data), ["error"]);
    }
    for (const action of ["save", "delete", "submit"]) {
      const denied = await own.client(
        `/diaries/${outside.draft.id}/${action}`,
        {
          version: outside.saved.version,
          title: "非法",
          entries: [],
          requestId: randomUUID(),
        },
      );
      assert.equal(denied.status, 404);
      assert.deepEqual(
        (await outside.client(`/diaries/${outside.draft.id}`)).data,
        outside.saved,
      );
    }
    const receipt = await own.client(
      `/diaries/${outside.draft.id}/submit`,
      outside.submitInput,
    );
    assert.equal(receipt.status, 409);
    assert.deepEqual(Object.keys(receipt.data), ["error"]);
    assert.ok(!JSON.stringify(receipt.data).includes(outside.name));
    const wrongOperation = await own.client("/diaries", {
      title: "另一操作",
      entries: [{ id: randomUUID(), body: "重用标识" }],
    });
    const rejected = await own.client(
      `/diaries/${wrongOperation.data.id}/submit`,
      own.submitInput,
    );
    assert.equal(rejected.status, 409);
    assert.deepEqual(
      (await own.client(`/diaries/${wrongOperation.data.id}`)).data,
      wrongOperation.data,
    );
  }
  assert.equal(
    (await f.colleague(`/diaries/${published[0].draft.id}`)).status,
    404,
  );
  assert.deepEqual(
    (await f.colleague(`/team-diaries/${published[0].draft.id}`)).data
      .published,
    published[0].submitted.published,
  );
  f.setTime("2026-09-17T04:00:00Z");
  for (const item of published) {
    const repeated = await item.client(`/diaries/${item.draft.id}/submit`, {
      version: item.saved.version,
      requestId: randomUUID(),
    });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.data.diaryDate, "2026-09-17");
    assert.equal(
      repeated.data.firstSubmittedAt,
      item.submitted.firstSubmittedAt,
    );
    assert.equal(repeated.data.submittedAt, Date.parse("2026-09-17T04:00:00Z"));
    assert.equal(repeated.data.published.title, `${item.name}私密修改`);
    const input = { version: repeated.data.version };
    assert.equal(
      (await item.client(`/diaries/${item.draft.id}/delete`, input)).status,
      200,
    );
    assert.equal(
      (await item.client(`/diaries/${item.draft.id}/delete`, input)).status,
      200,
    );
  }
  for (const [own, outside] of [
    [published[0], published[1]],
    [published[1], published[0]],
  ]) {
    assert.equal(
      (
        await own.client(`/diaries/${outside.draft.id}/delete`, {
          version: outside.saved.version,
        })
      ).status,
      404,
    );
    const events = await own.client(
      `/diary-events?memberId=${outside.identity.member.id}&teamId=${outside.identity.team.id}`,
    );
    assert.equal(events.status, 200);
    assert.deepEqual(events.data, [
      {
        diaryId: own.draft.id,
        action: "delete",
        at: Date.parse("2026-09-17T04:00:00Z"),
        member: { id: own.identity.member.id, name: own.identity.member.name },
      },
    ]);
    assert.deepEqual((await own.client("/team-diaries")).data, []);
  }
  await f.restart();
  assert.equal(
    (await f.colleague("/diary-events")).data[0].diaryId,
    published[0].draft.id,
  );
  assert.equal(
    (await f.foreign("/diary-events")).data[0].diaryId,
    published[1].draft.id,
  );
});

test("本人草稿和历史修改窗口不因同队或外队身份而放宽", async (t) => {
  const f = await teams(t);
  const entry = { id: randomUUID(), body: "私人工作" };
  const created = await f.author("/diaries", {
    title: "私人草稿",
    entries: [entry],
  });
  assert.equal(created.status, 201);
  const uploaded = await f.author(
    `/diaries/${created.data.id}/entries/${entry.id}/attachments`,
    {
      version: created.data.version,
      requestId: randomUUID(),
      name: "私有.txt",
      base64: Buffer.from("私有字节").toString("base64"),
    },
  );
  assert.equal(uploaded.status, 201);
  const file = uploaded.data.draft.entries[0].attachments[0];
  for (const client of [f.colleague, f.foreign]) {
    assert.deepEqual((await client("/diaries/mine")).data, []);
    assert.equal((await client(`/diaries/${created.data.id}`)).status, 404);
    assert.equal(
      (await client(`/team-diaries/${created.data.id}`)).status,
      404,
    );
    assert.equal((await client(`/attachments/${file.id}`)).status, 404);
    for (const action of ["save", "submit", "delete"]) {
      const denied = await client(`/diaries/${created.data.id}/${action}`, {
        version: uploaded.data.version,
        title: "篡改",
        entries: [],
        requestId: randomUUID(),
      });
      assert.equal(denied.status, 404);
      assert.deepEqual(Object.keys(denied.data), ["error"]);
      assert.deepEqual(
        (await f.author(`/diaries/${created.data.id}`)).data,
        uploaded.data,
      );
    }
  }
  const request = { version: uploaded.data.version, requestId: randomUUID() };
  const submitted = await f.author(
    `/diaries/${created.data.id}/submit`,
    request,
  );
  assert.equal(submitted.status, 200);
  for (const client of [f.colleague, f.foreign])
    assert.equal(
      (await client(`/diaries/${created.data.id}/submit`, request)).status,
      404,
    );
  const saved = await f.author(`/diaries/${created.data.id}/save`, {
    ...submitted.data.draft,
    version: submitted.data.version,
    title: "午夜未提交修改",
  });
  assert.equal(saved.status, 200);
  f.setTime("2026-09-16T16:00:00Z");
  const locked = (await f.author(`/diaries/${created.data.id}`)).data;
  assert.equal(locked.editable, false);
  assert.equal(locked.diaryDate, "2026-09-16");
  assert.equal(locked.draft.title, "午夜未提交修改");
  const actions = [
    [
      `/diaries/${created.data.id}/save`,
      { ...locked.draft, version: locked.version },
    ],
    [
      `/diaries/${created.data.id}/submit`,
      { version: locked.version, requestId: randomUUID() },
    ],
    [`/diaries/${created.data.id}/delete`, { version: locked.version }],
    [
      `/diaries/${created.data.id}/entries/${entry.id}/attachments`,
      {
        version: locked.version,
        requestId: randomUUID(),
        name: "新.txt",
        base64: "YQ==",
      },
    ],
    [
      `/diaries/${created.data.id}/attachments/cancel`,
      { requestId: randomUUID() },
    ],
  ] as const;
  for (const [path, input] of actions) {
    const denied = await f.author(path, input);
    assert.equal(denied.status, 409);
    assert.deepEqual(denied.data, {
      error: "历史日报已锁定，不能修改、重新提交或删除。",
    });
    assert.deepEqual(
      (await f.author(`/diaries/${created.data.id}`)).data,
      locked,
    );
  }
  assert.equal((await f.author(`/attachments/${file.id}`)).data, "私有字节");
  assert.equal((await f.colleague(`/attachments/${file.id}`)).data, "私有字节");
  assert.equal((await f.foreign(`/attachments/${file.id}`)).status, 404);
  assert.deepEqual(
    (await f.colleague(`/team-diaries/${created.data.id}`)).data.published,
    submitted.data.published,
  );
  assert.deepEqual((await f.author("/diary-events")).data, []);
});
