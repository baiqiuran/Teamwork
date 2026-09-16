import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fixture } from "./support.ts";

test("附件跟随工作条目版本，草稿与公开范围隔离，关闭链接撤销下载", async (t) => {
  const f = await fixture(t);
  const p = (await f.author("/projects", { name: "A", description: "" })).data;
  const q = (await f.author("/projects", { name: "B", description: "" })).data;
  const task = (
    await f.author(`/projects/${p.id}/tasks`, { name: "事项", description: "" })
  ).data;
  const entries = [
    { id: randomUUID(), body: "A", projectId: p.id, taskId: task.id },
    { id: randomUUID(), body: "B", projectId: q.id },
  ];
  let d = (await f.author("/diaries", { title: "附件", entries })).data;
  const upload = {
    name: "说明.txt",
    base64: Buffer.from("附件内容").toString("base64"),
    requestId: randomUUID(),
    version: d.version,
  };
  const result = await f.author(
    `/diaries/${d.id}/entries/${entries[0].id}/attachments`,
    upload,
  );
  assert.equal(result.status, 201);
  d = result.data;
  const file = d.draft.entries[0].attachments[0];
  assert.equal(
    (
      await f.author(
        `/diaries/${d.id}/entries/${entries[0].id}/attachments`,
        upload,
      )
    ).data.draft.entries[0].attachments.length,
    1,
  );
  assert.equal((await f.colleague(`/attachments/${file.id}`)).status, 404);
  assert.equal((await f.guest(`/attachments/${file.id}`)).status, 401);
  d = (
    await f.author(`/diaries/${d.id}/submit`, {
      version: d.version,
      requestId: randomUUID(),
    })
  ).data;
  const download = await f.colleague(`/attachments/${file.id}`);
  assert.equal(download.data, "附件内容");
  assert.equal(
    download.headers.get("content-type"),
    "application/octet-stream",
  );
  assert.equal(download.headers.get("cache-control"), "no-store");
  assert.equal(
    download.headers.get("content-disposition"),
    `attachment; filename*=UTF-8''${encodeURIComponent("说明.txt")}`,
  );
  const types = [
    ["diary", undefined],
    ["project", p.id],
    ["task", task.id],
  ] as const;
  const tokens = [];
  for (const [type, targetId] of types) {
    const s = (
      await f.colleague("/shares", {
        type,
        targetId,
        from: "2026-09-16",
        to: "2026-09-16",
        modules: ["progress"],
      })
    ).data;
    tokens.push(s);
    assert.equal(
      (await f.guest(`/public/${s.token}/attachments/${file.id}`)).data,
      "附件内容",
    );
  }
  const other = (
    await f.author("/shares", {
      type: "project",
      targetId: q.id,
      from: "2026-09-16",
      to: "2026-09-16",
      modules: ["progress"],
    })
  ).data;
  assert.equal(
    (await f.guest(`/public/${other.token}/attachments/${file.id}`)).status,
    404,
  );
  const hidden = (
    await f.author("/shares", {
      type: "diary",
      from: "2026-09-16",
      to: "2026-09-16",
      modules: ["overview"],
    })
  ).data;
  assert.equal(
    (await f.guest(`/public/${hidden.token}/attachments/${file.id}`)).status,
    404,
  );
  const additional = await f.author(
    `/diaries/${d.id}/entries/${entries[0].id}/attachments`,
    {
      ...upload,
      name: "未公开.txt",
      version: d.version,
      requestId: randomUUID(),
    },
  );
  const nextFile = additional.data.draft.entries[0].attachments[1];
  assert.equal((await f.colleague(`/attachments/${nextFile.id}`)).status, 404);
  assert.equal(
    (await f.guest(`/public/${tokens[0].token}/attachments/${nextFile.id}`))
      .status,
    404,
  );
  await f.colleague(`/shares/${tokens[0].id}/close`, {});
  assert.equal(
    (await f.guest(`/public/${tokens[0].token}/attachments/${file.id}`)).status,
    410,
  );
  const removed = (
    await f.author(`/diaries/${d.id}/save`, {
      version: additional.data.version,
      title: "",
      entries,
    })
  ).data;
  await f.author(`/diaries/${d.id}/submit`, {
    version: removed.version,
    requestId: randomUUID(),
  });
  assert.equal((await f.colleague(`/attachments/${file.id}`)).status, 404);
  assert.equal(
    (await f.guest(`/public/${tokens[1].token}/attachments/${file.id}`)).status,
    404,
  );
});

test("附件支持 20MB 上限，类型和数量限制失败不丢失草稿", async (t) => {
  const f = await fixture(t),
    entry = { id: randomUUID(), body: "限制测试" };
  let d = (await f.author("/diaries", { title: "保留正文", entries: [entry] }))
    .data;
  const path = `/diaries/${d.id}/entries/${entry.id}/attachments`;
  const invalid = await f.author(path, {
    version: d.version,
    requestId: randomUUID(),
    name: "脚本.html",
    base64: Buffer.from("html").toString("base64"),
  });
  assert.equal(invalid.status, 400);
  const broken = await f.author(path, {
    version: d.version,
    requestId: randomUUID(),
    name: "错误.txt",
    base64: "a?==",
  });
  assert.equal(broken.status, 400);
  assert.equal(broken.data.error, "文件内容不完整，请重新上传。");
  const tooLarge = await f.author(path, {
    version: d.version,
    requestId: randomUUID(),
    name: "超限.txt",
    base64: Buffer.alloc(20 * 1024 * 1024 + 1, 65).toString("base64"),
  });
  assert.equal(tooLarge.status, 400);
  const oversizedJson = await f.author("/diaries", {
    title: "普通请求",
    entries: [{ ...entry, body: "a".repeat(4 * 1024 * 1024) }],
  });
  // Baseline maps the parser's PayloadTooLargeError to this generic response.
  // Migration preserves that contract while retaining the ordinary 4 MiB limit.
  assert.equal(oversizedJson.status, 500);
  assert.deepEqual(oversizedJson.data, { error: "操作未完成，请稍后重试。" });
  const large = await f.author(path, {
    version: d.version,
    requestId: randomUUID(),
    name: "边界.txt",
    base64: Buffer.alloc(20 * 1024 * 1024, 65).toString("base64"),
  });
  assert.equal(large.status, 201);
  d = large.data;
  for (let i = 0; i < 9; i++) {
    const r = await f.author(path, {
      version: d.version,
      requestId: randomUUID(),
      name: `文件${i}.txt`,
      base64: "YQ==",
    });
    assert.equal(r.status, 201);
    d = r.data;
  }
  assert.equal(
    (
      await f.author(path, {
        version: d.version,
        requestId: randomUUID(),
        name: "超量.txt",
        base64: "YQ==",
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.author(`/diaries/${d.id}`)).data.draft.entries[0].attachments
      .length,
    10,
  );
  assert.equal(
    (await f.author(`/diaries/${d.id}`)).data.draft.title,
    "保留正文",
  );
});
