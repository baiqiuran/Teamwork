import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fixture } from "./support.ts";

test("已提交附件仅同团队可读，已知附件标识不授予外队文件权限", async (t) => {
  const f = await fixture(t);
  const foreign = f.client();
  assert.equal(
    (
      await foreign("/setup", {
        teamName: "附件外队",
        name: "外队成员",
        email: "foreign-file@example.test",
        password: "ForeignFiles2026!",
      })
    ).status,
    201,
  );
  const entry = { id: randomUUID(), body: "本团队文件" };
  const created = await f.author("/diaries", {
    title: "私有文件",
    entries: [entry],
  });
  const uploaded = await f.author(
    `/diaries/${created.data.id}/entries/${entry.id}/attachments`,
    {
      version: created.data.version,
      requestId: randomUUID(),
      name: "团队说明.txt",
      base64: Buffer.from("仅本团队可读的文件字节").toString("base64"),
    },
  );
  assert.equal(uploaded.status, 201);
  const file = uploaded.data.draft.entries[0].attachments[0];
  assert.equal(
    (await f.author(`/attachments/${file.id}`)).data,
    "仅本团队可读的文件字节",
  );
  for (const reader of [f.colleague, foreign])
    assert.equal((await reader(`/attachments/${file.id}`)).status, 404);
  const submitted = await f.author(`/diaries/${created.data.id}/submit`, {
    version: uploaded.data.version,
    requestId: randomUUID(),
  });
  assert.equal(submitted.status, 200);
  assert.equal(
    (await f.colleague(`/attachments/${file.id}`)).data,
    "仅本团队可读的文件字节",
  );
  const denied = await foreign(`/attachments/${file.id}`);
  assert.equal(denied.status, 404);
  assert.deepEqual(Object.keys(denied.data), ["error"]);
  assert.doesNotMatch(JSON.stringify(denied.data), /团队说明|文件字节/);
  await f.restart();
  assert.equal((await foreign(`/attachments/${file.id}`)).status, 404);
  assert.equal(
    (await f.colleague(`/attachments/${file.id}`)).data,
    "仅本团队可读的文件字节",
  );
});

test("附件上传取消和引用绑定本人日报条目，跨团队复用上传标识不共享文件", async (t) => {
  const f = await fixture(t);
  const foreign = f.client();
  assert.equal(
    (
      await foreign("/setup", {
        teamName: "附件隔离团队",
        name: "独立成员",
        email: "files-scope@example.test",
        password: "ScopedFiles2026!",
      })
    ).status,
    201,
  );
  const requestId = randomUUID();
  const items = [];
  for (const [client, name] of [
    [f.author, "作者"],
    [foreign, "外队"],
  ] as const) {
    const entries = [
      { id: randomUUID(), body: `${name}内容` },
      { id: randomUUID(), body: "另一个条目" },
    ];
    const draft = await client("/diaries", { title: name, entries });
    assert.equal(draft.status, 201);
    const input = {
      version: draft.data.version,
      requestId,
      name: `${name}.txt`,
      base64: Buffer.from(`${name}文件字节`).toString("base64"),
    };
    const path = `/diaries/${draft.data.id}/entries/${entries[0].id}/attachments`;
    const uploaded = await client(path, input);
    assert.equal(uploaded.status, 201);
    assert.deepEqual((await client(path, input)).data, uploaded.data);
    assert.equal(
      (await client(path, { ...input, name: "不同文件.txt" })).status,
      409,
    );
    assert.deepEqual(
      (await client(`/diaries/${draft.data.id}`)).data,
      uploaded.data,
    );
    items.push({
      client,
      name,
      draft: uploaded.data,
      input,
      file: uploaded.data.draft.entries[0].attachments[0],
      path,
    });
  }
  assert.notEqual(items[0].file.id, items[1].file.id);
  for (const [own, outside] of [
    [items[0], items[1]],
    [items[1], items[0]],
  ]) {
    for (const [path, input] of [
      [outside.path, { ...outside.input, version: outside.draft.version }],
      [`/diaries/${outside.draft.id}/attachments/cancel`, { requestId }],
    ] as const) {
      const denied = await own.client(path, input);
      assert.equal(denied.status, 404);
      assert.deepEqual(Object.keys(denied.data), ["error"]);
      assert.deepEqual(
        (await outside.client(`/diaries/${outside.draft.id}`)).data,
        outside.draft,
      );
    }
    const otherDiary = await own.client("/diaries", {
      title: "另一份",
      entries: [{ id: own.draft.draft.entries[0].id, body: "另一份内容" }],
    });
    assert.equal(otherDiary.status, 201);
    for (const [diary, entry, file] of [
      [own.draft, own.draft.draft.entries[0], outside.file],
      [own.draft, own.draft.draft.entries[1], own.file],
      [otherDiary.data, otherDiary.data.draft.entries[0], own.file],
    ]) {
      const denied = await own.client(`/diaries/${diary.id}/save`, {
        version: diary.version,
        title: "替换附件",
        entries: [
          { ...entry, attachments: [{ ...file, name: "伪造.txt", size: 1 }] },
        ],
      });
      assert.equal(denied.status, 404);
      assert.deepEqual((await own.client(`/diaries/${diary.id}`)).data, diary);
    }
    const deniedCreate = await own.client("/diaries", {
      title: "不能复用",
      entries: [
        {
          id: own.draft.draft.entries[0].id,
          body: "新日报",
          attachments: [own.file],
        },
      ],
    });
    assert.equal(deniedCreate.status, 404);
    const published = await own.client(`/diaries/${own.draft.id}/submit`, {
      version: own.draft.version,
      requestId: randomUUID(),
    });
    assert.equal(published.status, 200);
    assert.equal(
      (await outside.client(`/attachments/${own.file.id}`)).status,
      404,
    );
    const cancelled = await own.client(
      `/diaries/${own.draft.id}/attachments/cancel`,
      { requestId },
    );
    assert.equal(cancelled.status, 200);
    assert.deepEqual(cancelled.data.draft.entries[0].attachments, []);
    assert.deepEqual(cancelled.data.published, published.data.published);
    assert.equal(
      (await own.client(`/attachments/${own.file.id}`)).data,
      `${own.name}文件字节`,
    );
    const repeated = await own.client(`/diaries/${own.draft.id}/submit`, {
      version: cancelled.data.version,
      requestId: randomUUID(),
    });
    assert.equal(repeated.status, 200);
    assert.equal((await own.client(`/attachments/${own.file.id}`)).status, 404);
    own.draft = repeated.data;
  }
  for (const [path, input] of [
    [
      items[0].path,
      {
        ...items[0].input,
        requestId: randomUUID(),
        version: items[0].draft.version,
      },
    ],
    [`/diaries/${items[0].draft.id}/attachments/cancel`, { requestId }],
    [
      `/diaries/${items[0].draft.id}/submit`,
      { version: items[0].draft.version, requestId: randomUUID() },
    ],
  ] as const)
    assert.equal((await f.colleague(path, input)).status, 404);
  await f.restart();
  assert.deepEqual(
    (await f.author(`/diaries/${items[0].draft.id}`)).data,
    items[0].draft,
  );
  assert.deepEqual(
    (await foreign(`/diaries/${items[1].draft.id}`)).data,
    items[1].draft,
  );
});

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
