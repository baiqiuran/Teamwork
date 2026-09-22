import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { fixture } from "./support.ts";

type Client = Awaited<ReturnType<typeof fixture>>["author"];

async function request(
  client: Client,
  path: string,
  body?: unknown,
  status = 200,
) {
  const response = await client(path, body);
  assert.equal(
    response.status,
    status,
    `${path}: ${JSON.stringify(response.data)}`,
  );
  return response.data;
}

async function snapshot(client: Client, paths: string[]) {
  const result: Record<string, unknown> = {};
  for (const path of paths) result[path] = await request(client, path);
  return result;
}

async function teams(t: TestContext) {
  const f = await fixture(t);
  f.setTime("2026-09-17T01:00:00Z");
  const foreign = f.client();
  const foreignIdentity = await request(
    foreign,
    "/setup",
    {
      teamName: "原子性外队",
      name: "外队成员",
      email: "atomicity-foreign@example.test",
      password: "Atomicity2026!",
    },
    201,
  );
  // A normal login supplies a cookie for byte-exact, real HTTP downloads.
  const login = await f.author("/login", f.credentials);
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  async function bytes(id: string) {
    const response = await fetch(`${f.origin}/api/attachments/${id}`, {
      headers: { Cookie: cookie!, Connection: "close" },
    });
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "application/octet-stream",
    );
    return Buffer.from(await response.arrayBuffer());
  }
  return { ...f, foreign, foreignIdentity, bytes };
}

async function work(client: Client, name: string) {
  const project = await request(
    client,
    "/projects",
    {
      name: `${name}项目`,
      description: `${name}原始项目说明`,
    },
    201,
  );
  const task = await request(
    client,
    `/projects/${project.id}/tasks`,
    {
      name: `${name}任务`,
      description: `${name}原始任务说明`,
    },
    201,
  );
  return { project, task };
}

function workPaths(projectId: string, taskId: string) {
  return [
    "/projects",
    `/projects/${projectId}`,
    `/projects/${projectId}/tasks`,
    `/projects/${projectId}/progress`,
    `/tasks/${taskId}`,
    `/tasks/${taskId}/events`,
    `/tasks/${taskId}/progress`,
    "/diaries/mine",
    "/team-diaries",
    "/diary-events",
  ];
}

test("任务版本冲突回滚新任务与整份日报，同一提交标识修正版本后可重试且历史快照不变", async (t) => {
  const f = await teams(t);
  const own = await work(f.author, "本队");
  const outside = await work(f.foreign, "外队");
  const untouched = await request(
    f.author,
    `/projects/${own.project.id}/tasks`,
    {
      name: "不参与提交的任务",
      description: "必须保留的原始内容",
    },
    201,
  );
  const foreignDraft = await request(
    f.foreign,
    "/diaries",
    {
      title: "外队原始日报",
      entries: [
        {
          id: randomUUID(),
          body: "外队原始正文",
          projectId: outside.project.id,
          taskId: outside.task.id,
        },
      ],
    },
    201,
  );
  await request(f.foreign, `/diaries/${foreignDraft.id}/submit`, {
    version: foreignDraft.version,
    requestId: randomUUID(),
  });
  const outsidePaths = [
    ...workPaths(outside.project.id, outside.task.id),
    `/diaries/${foreignDraft.id}`,
    `/team-diaries/${foreignDraft.id}`,
  ];
  const outsideBefore = await snapshot(f.foreign, outsidePaths);

  const originalEntry = {
    id: randomUUID(),
    body: "已提交原文",
    projectId: own.project.id,
    taskId: own.task.id,
  };
  const created = await request(
    f.author,
    "/diaries",
    {
      title: "已提交原始标题",
      entries: [originalEntry],
    },
    201,
  );
  const originalBytes = Buffer.from("原始附件\n\u0000\u0001ÿ", "utf8");
  const uploaded = await request(
    f.author,
    `/diaries/${created.id}/entries/${originalEntry.id}/attachments`,
    {
      version: created.version,
      requestId: randomUUID(),
      name: "原始附件.txt",
      base64: originalBytes.toString("base64"),
    },
    201,
  );
  const file = uploaded.draft.entries[0].attachments[0];
  const original = await request(f.author, `/diaries/${created.id}/submit`, {
    version: uploaded.version,
    requestId: randomUUID(),
  });
  assert.equal(original.published.entries[0].taskStatus, "pending");
  const entries = [
    {
      id: randomUUID(),
      body: "未提交的新工作",
      projectId: own.project.id,
      newTask: { name: "随日报创建的唯一任务", description: "新增任务说明" },
    },
    {
      ...original.draft.entries[0],
      body: "未提交的完成说明",
      statusChange: { status: "done", expectedVersion: own.task.version },
    },
  ];
  const draft = await request(f.author, `/diaries/${created.id}/save`, {
    version: original.version,
    title: "未提交的原子修改",
    entries,
  });
  assert.deepEqual(draft.published, original.published);

  f.setTime("2026-09-17T01:01:00Z");
  const colleagueDraft = await request(
    f.colleague,
    "/diaries",
    {
      title: "同事先开始工作",
      entries: [
        {
          id: randomUUID(),
          body: "已开始",
          projectId: own.project.id,
          taskId: own.task.id,
          statusChange: {
            status: "in-progress",
            expectedVersion: own.task.version,
          },
        },
      ],
    },
    201,
  );
  const colleaguePublished = await request(
    f.colleague,
    `/diaries/${colleagueDraft.id}/submit`,
    {
      version: colleagueDraft.version,
      requestId: randomUUID(),
    },
  );
  const latestTask = await request(f.author, `/tasks/${own.task.id}`);
  assert.deepEqual(latestTask, {
    ...own.task,
    status: "in-progress",
    version: 2,
  });
  const priorEvents = await request(f.author, `/tasks/${own.task.id}/events`);
  assert.equal(priorEvents.length, 1);
  assert.deepEqual(priorEvents[0], {
    id: priorEvents[0].id,
    diaryId: colleagueDraft.id,
    kind: "diary",
    channel: "web",
    member: { id: f.other.member.id, name: f.other.member.name },
    before: "pending",
    after: "in-progress",
    at: Date.parse("2026-09-17T01:01:00Z"),
  });
  const ownPaths = [
    ...workPaths(own.project.id, own.task.id),
    `/diaries/${created.id}`,
    `/team-diaries/${created.id}`,
    `/team-diaries/${colleagueDraft.id}`,
    `/tasks/${untouched.id}`,
    `/tasks/${untouched.id}/events`,
  ];
  const ownBefore = await snapshot(f.author, ownPaths);
  const colleagueBefore = await snapshot(f.colleague, [
    "/diaries/mine",
    "/team-diaries",
  ]);
  const input = { version: draft.version, requestId: randomUUID() };
  f.setTime("2026-09-17T01:02:00Z");
  const conflict = await request(
    f.author,
    `/diaries/${created.id}/submit`,
    input,
    409,
  );
  assert.deepEqual(conflict.details.conflicts, [
    {
      taskId: own.task.id,
      taskName: own.task.name,
      latestStatus: "in-progress",
      latestVersion: 2,
      requestedStatus: "done",
    },
  ]);
  assert.deepEqual(await snapshot(f.author, ownPaths), ownBefore);
  assert.deepEqual(
    await snapshot(f.colleague, ["/diaries/mine", "/team-diaries"]),
    colleagueBefore,
  );
  assert.deepEqual(await snapshot(f.foreign, outsidePaths), outsideBefore);
  assert.deepEqual(await f.bytes(file.id), originalBytes);
  const visible = await request(f.colleague, `/team-diaries/${created.id}`);
  assert.deepEqual(visible.published, original.published);
  assert.equal("draft" in visible, false);
  assert.doesNotMatch(
    JSON.stringify(await request(f.colleague, "/team-diaries")),
    /未提交|外队/,
  );
  await request(f.foreign, `/team-diaries/${created.id}`, undefined, 404);
  await request(f.author, `/team-diaries/${foreignDraft.id}`, undefined, 404);

  const corrected = await request(f.author, `/diaries/${created.id}/save`, {
    version: draft.version,
    title: draft.draft.title,
    entries: [
      draft.draft.entries[0],
      {
        ...draft.draft.entries[1],
        statusChange: { status: "done", expectedVersion: latestTask.version },
      },
    ],
  });
  assert.deepEqual(corrected.published, original.published);
  const retryInput = { ...input, version: corrected.version };
  assert.notEqual(retryInput.version, input.version);
  const submitted = await request(
    f.author,
    `/diaries/${created.id}/submit`,
    retryInput,
  );
  assert.equal(submitted.version, corrected.version + 1);
  assert.equal(submitted.diaryDate, original.diaryDate);
  assert.equal(submitted.firstSubmittedAt, original.firstSubmittedAt);
  assert.equal(submitted.submittedAt, Date.parse("2026-09-17T01:02:00Z"));
  assert.deepEqual(submitted.published, submitted.draft);
  assert.equal(submitted.published.entries.length, 2);
  assert.equal(submitted.published.entries[0].taskName, "随日报创建的唯一任务");
  assert.equal(submitted.published.entries[0].taskStatus, "pending");
  assert.equal(submitted.published.entries[1].taskStatus, "done");
  assert.deepEqual(submitted.published.entries[1].attachments, [file]);
  const tasks = await request(f.author, `/projects/${own.project.id}/tasks`);
  assert.equal(tasks.length, 3);
  const newTask = await request(
    f.author,
    `/tasks/${submitted.published.entries[0].taskId}`,
  );
  assert.equal(newTask.name, "随日报创建的唯一任务");
  assert.equal(newTask.description, "新增任务说明");
  assert.equal(newTask.projectId, own.project.id);
  assert.equal(newTask.status, "pending");
  assert.equal(newTask.version, 1);
  assert.deepEqual(await request(f.author, `/tasks/${newTask.id}/events`), []);
  assert.deepEqual(
    await request(f.author, `/tasks/${untouched.id}`),
    untouched,
  );
  assert.deepEqual(await request(f.author, `/tasks/${own.task.id}`), {
    ...own.task,
    status: "done",
    version: 3,
  });
  const events = await request(f.author, `/tasks/${own.task.id}/events`);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], priorEvents[0]);
  assert.deepEqual(events[1], {
    id: events[1].id,
    diaryId: created.id,
    kind: "diary",
    channel: "web",
    member: { id: f.identity.member.id, name: f.identity.member.name },
    before: "in-progress",
    after: "done",
    at: Date.parse("2026-09-17T01:02:00Z"),
  });
  assert.notEqual(events[1].id, events[0].id);
  // Updating current task status must not rewrite the colleague's published snapshot.
  assert.deepEqual(
    (await request(f.author, `/team-diaries/${colleagueDraft.id}`)).published,
    colleaguePublished.published,
  );
  assert.equal(
    (await request(f.author, `/team-diaries/${colleagueDraft.id}`)).published
      .entries[0].taskStatus,
    "in-progress",
  );
  const successPaths = [
    ...ownPaths,
    `/tasks/${newTask.id}`,
    `/tasks/${newTask.id}/events`,
  ];
  const successBefore = await snapshot(f.author, successPaths);
  f.setTime("2026-09-17T01:03:00Z");
  assert.deepEqual(
    await request(f.author, `/diaries/${created.id}/submit`, retryInput),
    submitted,
  );
  assert.deepEqual(await snapshot(f.author, successPaths), successBefore);
  assert.deepEqual(await snapshot(f.foreign, outsidePaths), outsideBefore);
  assert.deepEqual(await f.bytes(file.id), originalBytes);
  await request(f.foreign, `/attachments/${file.id}`, undefined, 404);
});

test("外队关联保存返回404不改草稿，同队跨项目关联在新任务之后提交失败400且全部回滚", async (t) => {
  const f = await teams(t);
  const own = await work(f.author, "本队");
  const otherProject = await work(f.author, "同队另一");
  const outside = await work(f.foreign, "外队");
  const entries = [
    {
      id: randomUUID(),
      body: "先创建任务",
      projectId: own.project.id,
      newTask: { name: "失败时不能留下的任务", description: "保留草稿定义" },
    },
    {
      id: randomUUID(),
      body: "再更新已有任务",
      projectId: own.project.id,
      taskId: own.task.id,
      statusChange: { status: "done", expectedVersion: own.task.version },
    },
  ];
  const created = await request(
    f.author,
    "/diaries",
    {
      title: "原始私人草稿",
      entries,
    },
    201,
  );
  const originalBytes = Buffer.from("非法关联失败后仍可下载\n\u0000", "utf8");
  const draft = await request(
    f.author,
    `/diaries/${created.id}/entries/${entries[0].id}/attachments`,
    {
      version: created.version,
      requestId: randomUUID(),
      name: "草稿附件.txt",
      base64: originalBytes.toString("base64"),
    },
    201,
  );
  const file = draft.draft.entries[0].attachments[0];
  assert.equal(draft.published, null);
  const ownPaths = [
    ...workPaths(own.project.id, own.task.id),
    `/diaries/${draft.id}`,
    `/projects/${otherProject.project.id}`,
    `/projects/${otherProject.project.id}/tasks`,
    `/projects/${otherProject.project.id}/progress`,
    `/tasks/${otherProject.task.id}`,
    `/tasks/${otherProject.task.id}/events`,
  ];
  const ownBefore = await snapshot(f.author, ownPaths);
  const outsidePaths = workPaths(outside.project.id, outside.task.id);
  const outsideBefore = await snapshot(f.foreign, outsidePaths);
  for (const association of [
    { projectId: outside.project.id, taskId: outside.task.id },
    { projectId: outside.project.id, taskId: own.task.id },
    { projectId: own.project.id, taskId: outside.task.id },
  ]) {
    const denied = await request(
      f.author,
      `/diaries/${draft.id}/save`,
      {
        version: draft.version,
        title: "不能覆盖原文",
        entries: [
          draft.draft.entries[0],
          { ...draft.draft.entries[1], ...association },
        ],
      },
      404,
    );
    assert.deepEqual(Object.keys(denied), ["error"]);
    assert.deepEqual(await snapshot(f.author, ownPaths), ownBefore);
    assert.deepEqual(await snapshot(f.foreign, outsidePaths), outsideBefore);
    assert.deepEqual(await f.bytes(file.id), originalBytes);
  }

  // Same-team incomplete associations may be saved, but must fail at submission.
  const invalid = await request(f.author, `/diaries/${draft.id}/save`, {
    version: draft.version,
    title: draft.draft.title,
    entries: [
      draft.draft.entries[0],
      {
        ...draft.draft.entries[1],
        projectId: otherProject.project.id,
      },
    ],
  });
  const beforeSubmit = await snapshot(f.author, ownPaths);
  const input = { version: invalid.version, requestId: randomUUID() };
  await request(f.author, `/diaries/${draft.id}/submit`, input, 400);
  assert.deepEqual(await snapshot(f.author, ownPaths), beforeSubmit);
  assert.deepEqual(await snapshot(f.foreign, outsidePaths), outsideBefore);
  assert.deepEqual(await request(f.author, `/diaries/${draft.id}`), invalid);
  assert.deepEqual(
    await request(f.author, `/projects/${own.project.id}/tasks`),
    [own.task],
  );
  assert.deepEqual(await request(f.author, `/tasks/${own.task.id}/events`), []);
  assert.deepEqual(await f.bytes(file.id), originalBytes);
  for (const reader of [f.colleague, f.foreign]) {
    assert.deepEqual(await request(reader, "/team-diaries"), []);
    await request(reader, `/team-diaries/${draft.id}`, undefined, 404);
    await request(reader, `/diaries/${draft.id}`, undefined, 404);
    await request(reader, `/attachments/${file.id}`, undefined, 404);
  }
  const corrected = await request(f.author, `/diaries/${draft.id}/save`, {
    version: invalid.version,
    ...draft.draft,
  });
  const retryInput = { ...input, version: corrected.version };
  const published = await request(
    f.author,
    `/diaries/${draft.id}/submit`,
    retryInput,
  );
  assert.equal(published.published.entries[0].taskName, "失败时不能留下的任务");
  assert.equal(published.published.entries[1].taskStatus, "done");
  assert.equal(
    (await request(f.author, `/projects/${own.project.id}/tasks`)).length,
    2,
  );
  assert.equal(
    (await request(f.author, `/tasks/${own.task.id}/events`)).length,
    1,
  );
  assert.deepEqual(
    await request(f.author, `/projects/${otherProject.project.id}/tasks`),
    [otherProject.task],
  );
  assert.deepEqual(await snapshot(f.foreign, outsidePaths), outsideBefore);
  assert.deepEqual(await f.bytes(file.id), originalBytes);
});

test("附件元数据写入失败补偿真实文件，保留已有附件与草稿，原请求重试成功且不重复上传", async (t) => {
  const f = await teams(t);
  const entry = { id: randomUUID(), body: "必须保留的私人工作内容" };
  const created = await request(
    f.author,
    "/diaries",
    {
      title: "附件失败补偿",
      entries: [entry],
    },
    201,
  );
  const path = `/diaries/${created.id}/entries/${entry.id}/attachments`;
  const originalBytes = Buffer.from(
    "已有附件的原始字节\n\u0000\u0001ÿ",
    "utf8",
  );
  const original = await request(
    f.author,
    path,
    {
      version: created.version,
      requestId: randomUUID(),
      name: "已有附件.txt",
      base64: originalBytes.toString("base64"),
    },
    201,
  );
  const originalFile = original.draft.entries[0].attachments[0];
  const ownPaths = [
    `/diaries/${created.id}`,
    "/diaries/mine",
    "/team-diaries",
    "/diary-events",
  ];
  const ownBefore = await snapshot(f.author, ownPaths);
  const outsideBefore = await snapshot(f.foreign, [
    "/diaries/mine",
    "/team-diaries",
    "/diary-events",
  ]);
  const colleagueBefore = await snapshot(f.colleague, [
    "/diaries/mine",
    "/team-diaries",
  ]);
  const directory = join(dirname(f.databasePath), "attachments");
  const filesBefore = (await readdir(directory)).sort();
  assert.equal(filesBefore.length, 1);
  assert.deepEqual(await f.bytes(originalFile.id), originalBytes);
  for (const reader of [f.colleague, f.foreign])
    await request(reader, `/attachments/${originalFile.id}`, undefined, 404);

  const newBytes = Buffer.from("失败后重试的完整附件\n\u0000ÿ", "utf8");
  const input = {
    version: original.version,
    requestId: randomUUID(),
    name: "重试附件.txt",
    base64: newBytes.toString("base64"),
  };
  // Fault injection only: no business data is read or written through this connection.
  // Production writes the real file before inserting attachment metadata.
  const fault = new DatabaseSync(f.databasePath);
  try {
    fault.exec(`
      CREATE TRIGGER test_attachment_insert_failure
      BEFORE INSERT ON attachments
      BEGIN
        SELECT RAISE(ABORT, 'test failure');
      END;
    `);
  } finally {
    fault.close();
  }
  try {
    const failed = await request(f.author, path, input, 500);
    assert.deepEqual(failed, { error: "操作未完成，请稍后重试。" });
    assert.deepEqual((await readdir(directory)).sort(), filesBefore);
    assert.deepEqual(await snapshot(f.author, ownPaths), ownBefore);
    assert.deepEqual(
      await snapshot(f.colleague, ["/diaries/mine", "/team-diaries"]),
      colleagueBefore,
    );
    assert.deepEqual(
      await snapshot(f.foreign, [
        "/diaries/mine",
        "/team-diaries",
        "/diary-events",
      ]),
      outsideBefore,
    );
    assert.deepEqual(await f.bytes(originalFile.id), originalBytes);
    t.diagnostic(
      "Injected attachment INSERT failure returned HTTP 500; the real file was compensated and the draft stayed unchanged.",
    );
  } finally {
    const recovery = new DatabaseSync(f.databasePath);
    try {
      recovery.exec("DROP TRIGGER test_attachment_insert_failure");
    } finally {
      recovery.close();
    }
  }

  // The exact failed request, including its version and requestId, is reusable.
  const retried = await request(f.author, path, input, 201);
  assert.equal(retried.version, original.version + 1);
  assert.equal(retried.published, null);
  assert.equal(retried.draft.title, original.draft.title);
  assert.equal(retried.draft.entries[0].body, entry.body);
  const attachments = retried.draft.entries[0].attachments;
  assert.equal(attachments.length, 2);
  assert.deepEqual(attachments[0], originalFile);
  const newFile = attachments[1];
  assert.notEqual(newFile.id, originalFile.id);
  assert.equal(newFile.name, input.name);
  assert.equal(newFile.size, newBytes.length);
  assert.deepEqual(await f.bytes(originalFile.id), originalBytes);
  assert.deepEqual(await f.bytes(newFile.id), newBytes);
  const filesAfterRetry = (await readdir(directory)).sort();
  assert.equal(filesAfterRetry.length, filesBefore.length + 1);
  assert.ok(filesBefore.every((name) => filesAfterRetry.includes(name)));
  assert.deepEqual(await request(f.author, path, input, 201), retried);
  assert.deepEqual(await request(f.author, `/diaries/${created.id}`), retried);
  assert.deepEqual((await readdir(directory)).sort(), filesAfterRetry);
  assert.deepEqual(await f.bytes(originalFile.id), originalBytes);
  assert.deepEqual(await f.bytes(newFile.id), newBytes);
  for (const reader of [f.colleague, f.foreign]) {
    for (const file of [originalFile, newFile]) {
      const denied = await request(
        reader,
        `/attachments/${file.id}`,
        undefined,
        404,
      );
      assert.deepEqual(Object.keys(denied), ["error"]);
      assert.doesNotMatch(JSON.stringify(denied), /已有附件|重试附件|完整附件/);
    }
    await request(reader, `/diaries/${created.id}`, undefined, 404);
    await request(reader, `/team-diaries/${created.id}`, undefined, 404);
  }
  assert.deepEqual(
    await snapshot(f.colleague, ["/diaries/mine", "/team-diaries"]),
    colleagueBefore,
  );
  assert.deepEqual(
    await snapshot(f.foreign, [
      "/diaries/mine",
      "/team-diaries",
      "/diary-events",
    ]),
    outsideBefore,
  );
});
