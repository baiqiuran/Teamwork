import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fixture } from "./support.ts";

test("草稿跨日首次提交按服务器北京时间归档，团队只读完整提交版本且重复请求幂等", async (t) => {
  const f = await fixture(t);
  const d = (
    await f.author("/diaries", {
      title: "",
      entries: [
        { id: randomUUID(), body: "正文\n\n- 列表" },
        { id: randomUUID(), body: "  " },
      ],
    })
  ).data;
  assert.deepEqual((await f.colleague("/team-diaries")).data, []);
  assert.equal((await f.colleague(`/team-diaries/${d.id}`)).status, 404);
  f.setTime("2026-09-16T16:01:00Z");
  const input = {
    version: d.version,
    requestId: randomUUID(),
    diaryDate: "2000-01-01",
  };
  const submitted = await f.author(`/diaries/${d.id}/submit`, input);
  assert.equal(submitted.status, 200);
  assert.equal(submitted.data.diaryDate, "2026-09-17");
  assert.equal(submitted.data.published.entries.length, 1);
  assert.deepEqual(
    (await f.author(`/diaries/${d.id}/submit`, input)).data,
    submitted.data,
  );
  const records = (
    await f.colleague("/team-diaries?from=2026-09-17&to=2026-09-17")
  ).data;
  assert.equal(records.length, 1);
  assert.equal(records[0].published.entries[0].body, "正文\n\n- 列表");
  assert.equal(records[0].author.name, "林晓");
  assert.equal("draft" in records[0], false);
  assert.equal("email" in records[0].author, false);
  assert.deepEqual(
    (await f.colleague("/team-diaries?from=2026-09-16&to=2026-09-16")).data,
    [],
  );
  assert.equal((await f.guest("/team-diaries")).status, 401);
  const empty = (await f.author("/diaries", { title: "空日报", entries: [] }))
    .data;
  assert.equal(
    (
      await f.author(`/diaries/${empty.id}/submit`, {
        version: 1,
        requestId: randomUUID(),
      })
    ).status,
    400,
  );
  assert.equal((await f.colleague("/team-diaries")).data.length, 1);
});

test("当日修改草稿不影响已提交版本，重提不延长日期，跨日锁定，删除有内部记录", async (t) => {
  const f = await fixture(t);
  const entries = [{ id: randomUUID(), body: "初始正文" }];
  const d = (await f.author("/diaries", { title: "初始标题", entries })).data;
  const first = (
    await f.author(`/diaries/${d.id}/submit`, {
      version: 1,
      requestId: randomUUID(),
    })
  ).data;
  const saved = (
    await f.author(`/diaries/${d.id}/save`, {
      version: first.version,
      title: "私密修改",
      entries: [{ ...entries[0], body: "补充正文" }],
    })
  ).data;
  assert.equal(
    (await f.colleague(`/team-diaries/${d.id}`)).data.published.title,
    "初始标题",
  );
  assert.equal(
    (
      await f.colleague(`/diaries/${d.id}/save`, {
        version: saved.version,
        title: "",
        entries,
      })
    ).status,
    404,
  );
  const second = (
    await f.author(`/diaries/${d.id}/submit`, {
      version: saved.version,
      requestId: randomUUID(),
    })
  ).data;
  assert.equal(second.firstSubmittedAt, first.firstSubmittedAt);
  assert.equal(second.diaryDate, "2026-09-16");
  assert.equal(
    (await f.colleague(`/team-diaries/${d.id}`)).data.published.title,
    "私密修改",
  );
  await f.author(`/diaries/${d.id}/save`, {
    version: second.version,
    title: "午夜未提交",
    entries,
  });
  f.setTime("2026-09-16T16:00:00Z");
  const locked = (await f.author(`/diaries/${d.id}`)).data;
  assert.equal(locked.editable, false);
  assert.equal(locked.draft.title, "午夜未提交");
  for (const action of ["save", "submit", "delete"])
    assert.equal(
      (
        await f.author(`/diaries/${d.id}/${action}`, {
          version: locked.version,
          title: "",
          entries,
          requestId: randomUUID(),
          diaryDate: "2026-09-16",
        })
      ).status,
      409,
    );
  const fresh = (await f.author("/diaries", { title: "待删除", entries })).data;
  const pub = (
    await f.author(`/diaries/${fresh.id}/submit`, {
      version: 1,
      requestId: randomUUID(),
    })
  ).data;
  assert.equal(
    (await f.author(`/diaries/${fresh.id}/delete`, { version: pub.version }))
      .status,
    200,
  );
  assert.equal((await f.colleague(`/team-diaries/${fresh.id}`)).status, 404);
  const log = (await f.colleague("/diary-events")).data;
  assert.equal(
    log.filter((e: { diaryId: string }) => e.diaryId === fresh.id).length,
    1,
  );
  assert.equal(log[0].action, "delete");
  assert.equal(log[0].member.name, "林晓");
  assert.equal(JSON.stringify(log).includes("待删除"), false);
});
