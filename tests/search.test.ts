import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fixture } from "./support.ts";

test("成员项目日期组合筛选命中完整日报，超过一页仍返回全部，草稿不混入", async (t) => {
  const f = await fixture(t);
  const p = (await f.author("/projects", { name: "A", description: "" })).data;
  for (let i = 0; i < 31; i++) {
    const d = (
      await f.author("/diaries", {
        title: `第${i}份`,
        entries: [
          { id: randomUUID(), body: "A", projectId: p.id },
          { id: randomUUID(), body: "未关联工作" },
        ],
      })
    ).data;
    await f.author(`/diaries/${d.id}/submit`, {
      version: 1,
      requestId: randomUUID(),
    });
  }
  const other = (
    await f.colleague("/diaries", {
      title: "别人的",
      entries: [{ id: randomUUID(), body: "B" }],
    })
  ).data;
  await f.colleague(`/diaries/${other.id}/submit`, {
    version: 1,
    requestId: randomUUID(),
  });
  const filtered = (
    await f.author(
      `/team-diaries?from=2026-09-16&to=2026-09-16&memberId=${f.identity.member.id}&projectId=${p.id}`,
    )
  ).data;
  assert.equal(filtered.length, 31);
  assert.equal(filtered[0].published.entries.length, 2);
  assert.equal(
    (
      await f.author(
        `/team-diaries?projectId=${p.id}&memberId=${f.other.member.id}`,
      )
    ).data.length,
    0,
  );
  assert.equal(
    (await f.author("/team-diaries?from=2026-09-17&to=2026-09-16")).status,
    400,
  );
  assert.equal((await f.author("/members")).data.length, 2);
});
