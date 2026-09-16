import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fixture } from "./support.ts";

test("团队日报分享包含日期内所有成员完整提交，重提动态更新，仅生成者可关闭", async (t) => {
  const f = await fixture(t);
  const published = [];
  for (const [client, body] of [
    [f.author, "作者正文"],
    [f.colleague, "同事正文"],
  ] as const) {
    const d = (
      await client("/diaries", {
        title: "日报",
        entries: [{ id: randomUUID(), body }],
      })
    ).data;
    published.push(
      (
        await client(`/diaries/${d.id}/submit`, {
          version: 1,
          requestId: randomUUID(),
        })
      ).data,
    );
  }
  await f.author("/diaries", {
    title: "私密草稿",
    entries: [{ id: randomUUID(), body: "秘密" }],
  });
  const made = await f.colleague("/shares", {
    type: "diary",
    from: "2026-09-16",
    to: "2026-09-16",
  });
  assert.equal(made.status, 201);
  const s = made.data;
  const publicData = (await f.guest(`/public/${s.token}`)).data;
  assert.equal(publicData.progress.length, 2);
  assert.equal(JSON.stringify(publicData).includes("同事正文"), true);
  assert.equal(JSON.stringify(publicData).includes("秘密"), false);
  assert.equal(JSON.stringify(publicData).includes("email"), false);
  const d = published[0];
  const updated = (
    await f.author(`/diaries/${d.id}/save`, {
      version: d.version,
      title: "新标题",
      entries: [{ id: randomUUID(), body: "未重提正文" }],
    })
  ).data;
  assert.equal(
    JSON.stringify((await f.guest(`/public/${s.token}`)).data).includes(
      "未重提正文",
    ),
    false,
  );
  await f.author(`/diaries/${d.id}/submit`, {
    version: updated.version,
    requestId: randomUUID(),
  });
  assert.equal(
    JSON.stringify((await f.guest(`/public/${s.token}`)).data).includes(
      "未重提正文",
    ),
    true,
  );
  assert.equal((await f.author(`/shares/${s.id}/close`, {})).status, 403);
  await f.restart();
  assert.equal((await f.guest(`/public/${s.token}`)).status, 200);
  assert.equal((await f.colleague("/shares")).data.length, 1);
  assert.equal((await f.colleague(`/shares/${s.id}/close`, {})).status, 200);
  assert.equal((await f.guest(`/public/${s.token}`)).status, 410);
  assert.equal((await f.guest(`/public/${s.token}`, {})).status, 404);
});

test("项目与任务链接限定条目，模块从响应中隔离，当前任务状态和历史快照各自独立", async (t) => {
  const f = await fixture(t);
  const p = (await f.author("/projects", { name: "A", description: "A 说明" }))
    .data;
  const q = (await f.author("/projects", { name: "B", description: "B 说明" }))
    .data;
  const task = (
    await f.author(`/projects/${p.id}/tasks`, {
      name: "任务一",
      description: "任务原始说明",
    })
  ).data;
  const entries = [
    { id: randomUUID(), body: "公开 A", projectId: p.id, taskId: task.id },
    { id: randomUUID(), body: "B 私人范围", projectId: q.id },
    { id: randomUUID(), body: "其他工作" },
  ];
  const d = (
    await f.author("/diaries", { title: "完整日报标题含其他项目", entries })
  ).data;
  const pub = (
    await f.author(`/diaries/${d.id}/submit`, {
      version: 1,
      requestId: randomUUID(),
    })
  ).data;
  for (const [type, targetId] of [
    ["project", p.id],
    ["task", task.id],
  ]) {
    const s = await f.colleague("/shares", {
      type,
      targetId,
      from: "2026-09-16",
      to: "2026-09-16",
      modules: ["overview", "tasks", "progress"],
    });
    assert.equal(s.status, 201);
    const data = (await f.guest(`/public/${s.data.token}`)).data;
    assert.equal(data.progress[0].published.entries.length, 1);
    assert.equal(data.tasks.length, 1);
    assert.equal(JSON.stringify(data).includes("B 私人范围"), false);
    assert.equal(
      JSON.stringify(data).includes("完整日报标题含其他项目"),
      false,
    );
  }
  const modules = (
    await f.author("/shares", {
      type: "project",
      targetId: p.id,
      from: "2026-09-16",
      to: "2026-09-16",
      modules: ["overview"],
    })
  ).data;
  const only = (await f.guest(`/public/${modules.token}?module=progress`)).data;
  assert.equal("progress" in only, false);
  assert.equal("tasks" in only, false);
  assert.equal(JSON.stringify(only).includes("公开 A"), false);
  assert.equal(only.overview.diaryCount, 1);
  const outside = (
    await f.author("/shares", {
      type: "diary",
      from: "2026-09-15",
      to: "2026-09-15",
      modules: ["tasks", "progress"],
    })
  ).data;
  assert.equal(
    (await f.guest(`/public/${outside.token}`)).data.tasks.length,
    0,
  );
  const saved = (
    await f.author(`/diaries/${d.id}/save`, {
      version: pub.version,
      title: "",
      entries: [{ ...entries[0], projectId: q.id, taskId: undefined }],
    })
  ).data;
  await f.author(`/diaries/${d.id}/submit`, {
    version: saved.version,
    requestId: randomUUID(),
  });
  assert.equal(
    (await f.guest(`/public/${modules.token}`)).data.overview.diaryCount,
    0,
  );
});
