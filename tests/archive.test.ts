import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fixture } from "./support.ts";

test("仅创建者归档，拒绝迟到提交且保留草稿；专属分享及附件关闭，全团队历史保留，恢复不重开", async (t) => {
  const f = await fixture(t);
  const p = (await f.author("/projects", { name: "归档项目", description: "" }))
    .data;
  const task = (
    await f.author(`/projects/${p.id}/tasks`, { name: "事项", description: "" })
  ).data;
  const entry = {
    id: randomUUID(),
    body: "历史进展",
    projectId: p.id,
    taskId: task.id,
    statusChange: { status: "in-progress", expectedVersion: 1 },
  };
  let d = (await f.author("/diaries", { title: "历史", entries: [entry] }))
    .data;
  d = (
    await f.author(`/diaries/${d.id}/entries/${entry.id}/attachments`, {
      version: 1,
      requestId: randomUUID(),
      name: "历史.txt",
      base64: Buffer.from("历史附件").toString("base64"),
    })
  ).data;
  d = (
    await f.author(`/diaries/${d.id}/submit`, {
      version: d.version,
      requestId: randomUUID(),
    })
  ).data;
  const file = d.published.entries[0].attachments[0];
  const links = [];
  for (const [type, targetId] of [
    ["diary", undefined],
    ["project", p.id],
    ["task", task.id],
  ] as const)
    links.push(
      (
        await f.colleague("/shares", {
          type,
          targetId,
          from: "2026-09-16",
          to: "2026-09-16",
          modules: ["progress"],
        })
      ).data,
    );
  const pending = (
    await f.colleague("/diaries", {
      title: "迟到的进展",
      entries: [
        {
          ...entry,
          id: randomUUID(),
          statusChange: { status: "done", expectedVersion: 2 },
        },
      ],
    })
  ).data;
  assert.equal(
    (await f.colleague(`/projects/${p.id}/archive`, { archived: true })).status,
    403,
  );
  assert.equal(
    (await f.author(`/projects/${p.id}/archive`, { archived: true })).status,
    200,
  );
  assert.equal(
    (
      await f.colleague(`/diaries/${pending.id}/submit`, {
        version: 1,
        requestId: randomUUID(),
      })
    ).status,
    409,
  );
  assert.equal(
    (await f.colleague(`/diaries/${pending.id}`)).data.draft.title,
    "迟到的进展",
  );
  assert.equal(
    (await f.author(`/tasks/${task.id}`)).data.status,
    "in-progress",
  );
  for (const s of links.slice(1)) {
    assert.equal((await f.guest(`/public/${s.token}`)).status, 410);
    assert.equal(
      (await f.guest(`/public/${s.token}/attachments/${file.id}`)).status,
      410,
    );
  }
  assert.equal(
    (await f.guest(`/public/${links[0].token}`)).data.progress[0].published
      .entries[0].body,
    "历史进展",
  );
  assert.equal(
    (await f.guest(`/public/${links[0].token}/attachments/${file.id}`)).data,
    "历史附件",
  );
  await f.author(`/projects/${p.id}/archive`, { archived: false });
  assert.equal((await f.guest(`/public/${links[1].token}`)).status, 410);
  const fresh = (
    await f.author("/shares", {
      type: "project",
      targetId: p.id,
      from: "2026-09-16",
      to: "2026-09-16",
    })
  ).data;
  assert.equal((await f.guest(`/public/${fresh.token}`)).status, 200);
  assert.equal(
    (await f.colleague(`/tasks/${task.id}/archive`, { archived: true })).status,
    403,
  );
  assert.equal(
    (await f.author(`/tasks/${task.id}/archive`, { archived: true })).status,
    200,
  );
  assert.equal(
    (
      await f.colleague(`/diaries/${pending.id}/submit`, {
        version: 1,
        requestId: randomUUID(),
      })
    ).status,
    409,
  );
  assert.equal((await f.author(`/tasks/${task.id}/events`)).data.length, 1);
});
