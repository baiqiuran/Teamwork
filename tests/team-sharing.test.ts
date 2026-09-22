import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { fixture } from "./support.ts";

const day = "2026-09-16";
const allModules = ["overview", "tasks", "progress"];
const ownSecrets = [
  "青山项目",
  "青山任务",
  "青山已提交工作",
  "林晓",
  "周宁",
  "lin@example.test",
  "zhou@example.test",
];
const foreignSecrets = [
  "蓝海项目",
  "蓝海任务",
  "蓝海机密工作",
  "蓝海成员",
  "blue-share@example.test",
];

type Client = Awaited<ReturnType<typeof fixture>>["author"];

async function teams(t: TestContext) {
  const f = await fixture(t);
  const foreign = f.client();
  const outside = await foreign("/setup", {
    teamName: "蓝海团队",
    name: "蓝海成员",
    email: "blue-share@example.test",
    password: "BlueSharing2026!",
  });
  assert.equal(outside.status, 201);
  async function work(client: Client, name: string) {
    const project = await client("/projects", {
      name: `${name}项目`,
      description: `${name}项目说明`,
    });
    assert.equal(project.status, 201);
    const task = await client(`/projects/${project.data.id}/tasks`, {
      name: `${name}任务`,
      description: `${name}任务说明`,
    });
    assert.equal(task.status, 201);
    return { project: project.data, task: task.data };
  }
  async function publish(
    client: Client,
    objects: Awaited<ReturnType<typeof work>>,
    body: string,
    withFile = false,
    date = day,
  ) {
    const entry = {
      id: randomUUID(),
      body,
      projectId: objects.project.id,
      taskId: objects.task.id,
    };
    const created = await client("/diaries", { title: body, entries: [entry] });
    assert.equal(created.status, 201);
    let version = created.data.version;
    let file: { id: string; name: string; size: number } | undefined;
    if (withFile) {
      const uploaded = await client(
        `/diaries/${created.data.id}/entries/${entry.id}/attachments`,
        {
          version,
          requestId: randomUUID(),
          name: `${body}.txt`,
          base64: Buffer.from(`${body}的字节`).toString("base64"),
        },
      );
      assert.equal(uploaded.status, 201);
      file = uploaded.data.draft.entries[0].attachments[0];
      version = uploaded.data.version;
    }
    const submitted = await client(`/diaries/${created.data.id}/submit`, {
      version,
      requestId: randomUUID(),
    });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
    assert.equal(submitted.data.diaryDate, date);
    return { diary: submitted.data, file };
  }
  const own = await work(f.author, "青山");
  const outsideWork = await work(foreign, "蓝海");
  const ownRecord = await publish(f.author, own, "青山已提交工作", true);
  const outsideRecord = await publish(
    foreign,
    outsideWork,
    "蓝海机密工作",
    true,
  );
  async function share(client: Client, input: object) {
    const response = await client("/shares", input);
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data as { id: string; token: string };
  }
  async function view(client: Client, token: string, query = "") {
    const response = await client(`/public/${token}${query}`);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data;
  }
  async function denied(
    client: Client,
    path: string,
    status: number,
    secrets: string[],
  ) {
    const response = await client(path);
    assert.equal(
      response.status,
      status,
      `${path}: ${JSON.stringify(response.data)}`,
    );
    const text = JSON.stringify(response.data);
    assert.deepEqual(Object.keys(response.data), ["error"], text);
    for (const secret of secrets)
      assert.ok(!text.includes(secret), `${path} leaked ${secret}`);
    return response;
  }
  return {
    ...f,
    foreign,
    outside: outside.data,
    own,
    outsideWork,
    ownRecord,
    outsideRecord,
    share,
    view,
    denied,
    publish,
    work,
  };
}

test("三类公开链接按生成者团队、目标、日期和模块授权，附加参数与登录身份不能扩大范围", async (t) => {
  const f = await teams(t);
  const links = {
    diary: await f.share(f.author, {
      type: "diary",
      from: day,
      to: day,
      modules: allModules,
    }),
    project: await f.share(f.author, {
      type: "project",
      targetId: f.own.project.id,
      from: day,
      to: day,
      modules: allModules,
    }),
    task: await f.share(f.author, {
      type: "task",
      targetId: f.own.task.id,
      from: day,
      to: day,
      modules: allModules,
    }),
  };
  for (const [type, link] of Object.entries(links)) {
    const anonymous = await f.view(f.guest, link.token);
    assert.deepEqual(
      await f.view(f.colleague, link.token),
      anonymous,
      `${type} 同团队成员`,
    );
    assert.deepEqual(
      await f.view(f.foreign, link.token),
      anonymous,
      `${type} 外队已登录成员`,
    );
    const text = JSON.stringify(anonymous);
    assert.equal(anonymous.type, type);
    assert.deepEqual(anonymous.modules, allModules);
    assert.equal(anonymous.from, day);
    assert.deepEqual(
      anonymous.progress.map((record: any) => record.published.entries[0].body),
      ["青山已提交工作"],
    );
    assert.deepEqual(
      anonymous.tasks.map((task: any) => task.name),
      ["青山任务"],
    );
    assert.deepEqual(anonymous.tasks[0].creator, {
      id: f.identity.member.id,
      name: "林晓",
    });
    assert.equal(anonymous.tasks[0].status, "pending");
    assert.ok(!foreignSecrets.some((secret) => text.includes(secret)), text);
    assert.ok(!text.includes("email") && !text.includes("draft"), text);
    if (type === "diary") {
      assert.equal(anonymous.overview.name, "全团队日报");
      assert.equal(anonymous.overview.diaryCount, 1);
      assert.equal(anonymous.overview.entryCount, 1);
      assert.equal(anonymous.overview.taskCount, 1);
    } else {
      assert.equal(
        anonymous.overview.name,
        type === "project" ? f.own.project.name : f.own.task.name,
      );
      assert.equal(anonymous.overview.creator.id, f.identity.member.id);
    }
    const widened = await f.view(
      f.guest,
      link.token,
      `?type=project&projectId=${f.outsideWork.project.id}&taskId=${f.outsideWork.task.id}&memberId=${f.outside.member.id}&from=2000-01-01&to=2100-01-01&modules=${allModules.join(",")}`,
    );
    assert.deepEqual(widened, anonymous, `${type} 查询参数不能扩大公开范围`);
  }
  const outsideLink = await f.share(f.foreign, {
    type: "project",
    targetId: f.outsideWork.project.id,
    from: day,
    to: day,
    modules: allModules,
  });
  const outsideView = await f.view(f.guest, outsideLink.token);
  assert.deepEqual(
    outsideView.progress.map((record: any) => record.published.entries[0].body),
    ["蓝海机密工作"],
  );
  assert.ok(
    !ownSecrets.some((secret) => JSON.stringify(outsideView).includes(secret)),
  );
  const empty = await f.view(
    f.guest,
    (
      await f.share(f.author, {
        type: "diary",
        from: "2026-09-15",
        to: "2026-09-15",
        modules: allModules,
      })
    ).token,
  );
  assert.deepEqual(empty.progress, []);
  assert.deepEqual(empty.tasks, []);
  assert.equal(empty.overview.diaryCount, 0);
  const partial = await f.view(
    f.guest,
    (
      await f.share(f.author, {
        type: "task",
        targetId: f.own.task.id,
        from: day,
        to: day,
        modules: ["tasks"],
      })
    ).token,
  );
  assert.deepEqual(Object.keys(partial).sort(), [
    "from",
    "modules",
    "tasks",
    "to",
    "type",
  ]);
  assert.deepEqual(
    partial.tasks.map((task: any) => task.name),
    ["青山任务"],
  );
});

test("公开附件按链接状态、进展模块与已提交引用授权，替换标识或换链接不能绕过", async (t) => {
  const f = await teams(t);
  const progress = await f.share(f.author, {
    type: "project",
    targetId: f.own.project.id,
    from: day,
    to: day,
    modules: ["overview", "progress"],
  });
  const overviewOnly = await f.share(f.author, {
    type: "project",
    targetId: f.own.project.id,
    from: day,
    to: day,
    modules: ["overview"],
  });
  const ownFile = f.ownRecord.file!;
  const bytes = await f.guest(
    `/public/${progress.token}/attachments/${ownFile.id}`,
  );
  assert.equal(bytes.status, 200);
  assert.equal(bytes.data, "青山已提交工作的字节");
  assert.equal(bytes.headers.get("content-type"), "application/octet-stream");
  assert.equal(bytes.headers.get("cache-control"), "no-store");
  await f.denied(
    f.guest,
    `/public/${overviewOnly.token}/attachments/${ownFile.id}`,
    404,
    ownSecrets,
  );
  await f.denied(
    f.guest,
    `/public/${progress.token}/attachments/${f.outsideRecord.file!.id}`,
    404,
    foreignSecrets,
  );
  // 已登录但属于其他团队的成员持有效链接仍按公开授权读取，不因此误拒绝。
  const asOutsider = await f.foreign(
    `/public/${progress.token}/attachments/${ownFile.id}`,
  );
  assert.equal(asOutsider.status, 200);
  assert.equal(asOutsider.data, "青山已提交工作的字节");
  await f.denied(f.guest, `/attachments/${ownFile.id}`, 401, ownSecrets);
  const diaryLink = await f.share(f.author, {
    type: "diary",
    from: day,
    to: day,
    modules: ["progress"],
  });
  const otherProject = await f.work(f.author, "青山另一");
  const outsideScope = await f.publish(
    f.colleague,
    otherProject,
    "青山另一项目工作",
    true,
    day,
  );
  await f.denied(
    f.guest,
    `/public/${progress.token}/attachments/${outsideScope.file!.id}`,
    404,
    ["青山另一项目工作"],
  );
  const insideDiaryLink = await f.guest(
    `/public/${diaryLink.token}/attachments/${outsideScope.file!.id}`,
  );
  assert.equal(insideDiaryLink.status, 200);
  assert.equal(insideDiaryLink.data, "青山另一项目工作的字节");
  const draft = await f.author("/diaries", {
    title: "青山草稿附件",
    entries: [{ id: randomUUID(), body: "草稿正文" }],
  });
  const draftEntryId = draft.data.draft.entries[0].id;
  const draftUpload = await f.author(
    `/diaries/${draft.data.id}/entries/${draftEntryId}/attachments`,
    {
      version: draft.data.version,
      requestId: randomUUID(),
      name: "草稿.txt",
      base64: Buffer.from("草稿字节").toString("base64"),
    },
  );
  assert.equal(draftUpload.status, 201);
  const draftFile = draftUpload.data.draft.entries[0].attachments[0];
  await f.denied(
    f.guest,
    `/public/${diaryLink.token}/attachments/${draftFile.id}`,
    404,
    ["草稿"],
  );
  await f.denied(
    f.guest,
    `/public/${progress.token}/attachments/${draftFile.id}`,
    404,
    ["草稿"],
  );
  const closed = await f.share(f.author, {
    type: "task",
    targetId: f.own.task.id,
    from: day,
    to: day,
    modules: ["progress"],
  });
  await f.author(`/shares/${closed.id}/close`, {});
  assert.equal((await f.guest(`/public/${closed.token}`)).status, 410);
  const afterClose = await f.guest(
    `/public/${closed.token}/attachments/${ownFile.id}`,
  );
  assert.equal(afterClose.status, 410);
  assert.deepEqual(Object.keys(afterClose.data), ["error"]);
});

test("公开链接列表与关闭仍限生成者，跨团队对象不能生成或管理链接", async (t) => {
  const f = await teams(t);
  const mine = await f.share(f.author, {
    type: "diary",
    from: day,
    to: day,
    modules: ["progress"],
  });
  const outsideLink = await f.share(f.foreign, {
    type: "project",
    targetId: f.outsideWork.project.id,
    from: day,
    to: day,
    modules: ["progress"],
  });
  assert.deepEqual(
    (await f.author("/shares")).data.map((s: any) => s.id),
    [mine.id],
  );
  assert.deepEqual(
    (await f.foreign("/shares")).data.map((s: any) => s.id),
    [outsideLink.id],
  );
  for (const [client, name] of [
    [f.colleague, "同团队非生成者"],
    [f.foreign, "外队成员"],
  ] as const) {
    const denied = await client(`/shares/${mine.id}/close`, {});
    assert.equal(
      denied.status,
      name === "外队成员" ? 404 : 403,
      JSON.stringify(denied.data),
    );
    assert.deepEqual(Object.keys(denied.data), ["error"]);
    assert.equal((await f.view(f.guest, mine.token)).progress.length, 1);
    assert.equal((await f.author("/shares")).data[0].closed, false);
  }
  for (const [type, targetId] of [
    ["project", f.outsideWork.project.id],
    ["task", f.outsideWork.task.id],
  ] as const) {
    const rejected = await f.author("/shares", {
      type,
      targetId,
      from: day,
      to: day,
      modules: ["progress"],
    });
    assert.equal(rejected.status, 404, JSON.stringify(rejected.data));
    assert.deepEqual(Object.keys(rejected.data), ["error"]);
    assert.doesNotMatch(JSON.stringify(rejected.data), /蓝海/);
  }
  const before = (await f.foreign("/shares")).data;
  assert.equal((await f.author("/shares")).data.length, 1);
  const closed = await f.author(`/shares/${mine.id}/close`, {});
  assert.equal(closed.status, 200);
  assert.equal((await f.author("/shares")).data[0].closed, true);
  assert.deepEqual((await f.foreign("/shares")).data, before);
  await f.denied(f.guest, `/public/${mine.token}`, 410, ownSecrets);
  await f.denied(
    f.guest,
    `/public/${mine.token}/attachments/${f.ownRecord.file!.id}`,
    410,
    ownSecrets,
  );
  assert.equal((await f.view(f.guest, outsideLink.token)).progress.length, 1);
  await f.restart();
  assert.equal((await f.author("/shares")).data[0].closed, true);
  assert.equal((await f.guest(`/public/${mine.token}`)).status, 410);
});
