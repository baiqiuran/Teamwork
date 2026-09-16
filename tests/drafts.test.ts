import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fixture } from "./support.ts";

test("多份私人草稿保存段落、列表、稳定条目顺序，重启和跨日可继续编辑删除", async (t) => {
  const f = await fixture(t);
  const entries = [
    { id: randomUUID(), body: "第一段\n\n第二段\n- 检查接口\n- 完成文档" },
    { id: randomUUID(), body: "另一项工作" },
  ];
  const created = await f.author("/diaries", { title: "今天的工作", entries });
  assert.equal(created.status, 201);
  const diary = created.data;
  assert.equal(diary.diaryDate, null);
  assert.deepEqual(diary.draft.entries, entries);
  assert.equal(
    (await f.author("/diaries", { title: "", entries: [] })).status,
    201,
  );
  assert.equal((await f.author("/diaries/mine")).data.length, 2);
  await f.restart();
  assert.deepEqual(
    (await f.author(`/diaries/${diary.id}`)).data.draft.entries,
    entries,
  );
  f.setTime("2026-09-16T16:01:00Z");
  const updated = await f.author(`/diaries/${diary.id}/save`, {
    version: diary.version,
    title: "",
    entries: [...entries].reverse(),
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.data.draft.entries, [...entries].reverse());
  assert.equal(updated.data.diaryDate, null);
  assert.equal(
    (
      await f.author(`/diaries/${diary.id}/delete`, {
        version: updated.data.version,
      })
    ).status,
    200,
  );
  assert.equal((await f.author(`/diaries/${diary.id}`)).status, 404);
});

test("私人草稿不能被其他成员或匿名用户读取修改，限制内容长度且防止旧窗口覆盖", async (t) => {
  const f = await fixture(t);
  const d = (
    await f.author("/diaries", {
      title: "私密标题",
      entries: [{ id: randomUUID(), body: "私密正文" }],
    })
  ).data;
  assert.equal((await f.colleague("/diaries/mine")).data.length, 0);
  assert.equal((await f.colleague(`/diaries/${d.id}`)).status, 404);
  assert.equal((await f.guest(`/diaries/${d.id}`)).status, 401);
  for (const action of ["save", "delete"])
    assert.equal(
      (
        await f.colleague(`/diaries/${d.id}/${action}`, {
          version: 1,
          title: "",
          entries: [],
        })
      ).status,
      404,
    );
  assert.equal(
    (
      await f.author(`/diaries/${d.id}/save`, {
        version: 1,
        title: "x".repeat(101),
        entries: [],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.author(`/diaries/${d.id}/save`, {
        version: 1,
        title: "",
        entries: [{ id: randomUUID(), body: "x".repeat(10001) }],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.author(`/diaries/${d.id}/save`, {
        version: 1,
        title: "",
        entries: Array.from({ length: 51 }, () => ({
          id: randomUUID(),
          body: "",
        })),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.author(`/diaries/${d.id}/save`, {
        version: 1,
        title: "新标题",
        entries: [],
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.author(`/diaries/${d.id}/delete`, { version: 1 })).status,
    409,
  );
  assert.equal(
    (
      await f.author(`/diaries/${d.id}/save`, {
        version: 1,
        title: "旧窗口",
        entries: [],
      })
    ).status,
    409,
  );
});
