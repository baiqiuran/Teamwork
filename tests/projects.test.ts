import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fixture } from "./support.ts";

test("项目关联覆盖整个工作条目；草稿隔离，重提重新归集，删除同步移除", async (t) => {
  const f = await fixture(t);
  const a = await f.author("/projects", {
    name: "项目 A",
    description: "说明 A",
  });
  assert.equal(a.status, 201);
  const b = (
    await f.colleague("/projects", { name: "项目 B", description: "" })
  ).data;
  assert.equal(
    (
      await f.colleague(`/projects/${a.data.id}/save`, {
        name: "篡改",
        description: "",
      })
    ).status,
    403,
  );
  const entries = [
    { id: randomUUID(), body: "A 段落一\n\nA 段落二", projectId: a.data.id },
    { id: randomUUID(), body: "B 工作", projectId: b.id },
    { id: randomUUID(), body: "内部例会" },
  ];
  const diary = (await f.author("/diaries", { title: "多项目日报", entries }))
    .data;
  assert.equal(
    (await f.colleague(`/projects/${a.data.id}/progress`)).data.length,
    0,
  );
  const p = (
    await f.author(`/diaries/${diary.id}/submit`, {
      version: 1,
      requestId: randomUUID(),
    })
  ).data;
  assert.equal(p.published.entries.length, 3);
  const progress = (await f.colleague(`/projects/${a.data.id}/progress`)).data;
  assert.equal(progress[0].published.entries.length, 1);
  assert.equal(progress[0].published.entries[0].body, "A 段落一\n\nA 段落二");
  assert.equal(JSON.stringify(progress).includes("内部例会"), false);
  entries[0].projectId = b.id;
  const saved = (
    await f.author(`/diaries/${diary.id}/save`, {
      version: p.version,
      title: "多项目日报",
      entries,
    })
  ).data;
  assert.equal(
    (await f.colleague(`/projects/${a.data.id}/progress`)).data.length,
    1,
  );
  const resubmitted = (
    await f.author(`/diaries/${diary.id}/submit`, {
      version: saved.version,
      requestId: randomUUID(),
    })
  ).data;
  assert.equal(
    (await f.colleague(`/projects/${a.data.id}/progress`)).data.length,
    0,
  );
  assert.equal(
    (await f.colleague(`/projects/${b.id}/progress`)).data[0].published.entries
      .length,
    2,
  );
  assert.equal(
    (
      await f.colleague(
        `/projects/${b.id}/progress?from=2026-09-15&to=2026-09-15`,
      )
    ).data.length,
    0,
  );
  await f.author(`/diaries/${diary.id}/delete`, {
    version: resubmitted.version,
  });
  assert.equal(
    (await f.colleague(`/projects/${b.id}/progress`)).data.length,
    0,
  );
});
