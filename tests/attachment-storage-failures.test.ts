import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fixture } from "./support.ts";

const {
  localFiles,
}: typeof import("../server/modules/attachments/infrastructure/files.ts") =
  await import(
    pathToFileURL(
      resolve("build/server/modules/attachments/infrastructure/files.js"),
    ).href
  );

for (const cleanupFails of [false, true]) {
  test(`附件部分写入失败保持草稿与请求可重试${cleanupFails ? "，清理失败仍不报成功" : "，清理部分文件"}`, async (t) => {
    const f = await fixture(t);
    const entry = { id: randomUUID(), body: "保留原内容" };
    const created = await f.author("/diaries", {
      title: "上传故障",
      entries: [entry],
    });
    assert.equal(created.status, 201);
    const diary = created.data;
    const path = `/diaries/${diary.id}/entries/${entry.id}/attachments`;
    const bytes = Buffer.from("完整附件字节");
    const input = {
      version: diary.version,
      requestId: randomUUID(),
      name: "附件.txt",
      base64: bytes.toString("base64"),
    };
    const directory = join(dirname(f.databasePath), "attachments");
    const before = await readdir(directory);
    const originalOpen = fs.openSync;
    const originalWrite = fs.writeFileSync;
    const originalUnlink = fs.unlinkSync;
    let descriptor: number | undefined;
    let partialPath: string | undefined;
    const logs: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => logs.push(args));
    t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      const fd = originalOpen(...args);
      if (typeof args[0] === "string" && dirname(args[0]) === directory) {
        descriptor = fd;
        partialPath = args[0];
      }
      return fd;
    });
    t.mock.method(
      fs,
      "writeFileSync",
      (...args: Parameters<typeof fs.writeFileSync>) => {
        if (
          (typeof args[0] === "string" && dirname(args[0]) === directory) ||
          args[0] === descriptor
        ) {
          if (typeof args[0] === "string") partialPath = args[0];
          originalWrite(args[0], bytes.subarray(0, 1), args[2]);
          throw Object.assign(new Error("isolated partial write"), {
            code: "ENOSPC",
          });
        }
        return originalWrite(...args);
      },
    );
    if (cleanupFails)
      t.mock.method(
        fs,
        "unlinkSync",
        (...args: Parameters<typeof fs.unlinkSync>) => {
          if (args[0] === partialPath)
            throw Object.assign(new Error("isolated cleanup failure"), {
              code: "EACCES",
            });
          return originalUnlink(...args);
        },
      );
    syncBuiltinESMExports();
    try {
      const failed = await f.author(path, input);
      assert.equal(failed.status, 500);
      assert.deepEqual(failed.data, { error: "操作未完成，请稍后重试。" });
      assert.deepEqual((await f.author(`/diaries/${diary.id}`)).data, diary);
      assert.ok(partialPath);
      if (cleanupFails) {
        assert.equal(fs.statSync(partialPath).size, 1);
        const diagnostic = logs.find(
          ([label]) => label === "Attachment compensation failed:",
        );
        assert.deepEqual(diagnostic?.[1], {
          attachmentId: basename(partialPath),
          phase: "partial-write",
          writeCode: "ENOSPC",
          cleanupCode: "EACCES",
        });
        assert.equal(JSON.stringify(logs).includes(directory), false);
        assert.equal(JSON.stringify(logs).includes("完整附件字节"), false);
      } else {
        assert.deepEqual(await readdir(directory), before);
      }
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      if (cleanupFails && partialPath && fs.existsSync(partialPath))
        originalUnlink(partialPath);
    }
    const retried = await f.author(path, input);
    assert.equal(retried.status, 201);
    assert.equal(retried.data.version, diary.version + 1);
    assert.equal(retried.data.draft.entries[0].attachments.length, 1);
    const file = retried.data.draft.entries[0].attachments[0];
    assert.deepEqual(fs.readFileSync(join(directory, file.id)), bytes);
    assert.deepEqual((await f.author(path, input)).data, retried.data);
    assert.equal((await readdir(directory)).length, before.length + 1);
  });
}

test("完整写入后数据库失败且补偿失败仍保留安全诊断与原草稿", async (t) => {
  const f = await fixture(t),
    entry = { id: randomUUID(), body: "保留原草稿" };
  const created = await f.author("/diaries", {
    title: "数据库失败",
    entries: [entry],
  });
  const diary = created.data;
  const path = `/diaries/${diary.id}/entries/${entry.id}/attachments`;
  const input = {
    version: diary.version,
    requestId: randomUUID(),
    name: "私有附件名.txt",
    base64: Buffer.from("私有内容").toString("base64"),
  };
  const directory = join(dirname(f.databasePath), "attachments");
  const connection = new DatabaseSync(f.databasePath);
  connection.exec(
    "CREATE TRIGGER test_cleanup_failure BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'isolated metadata failure'); END",
  );
  connection.close();
  const originalUnlink = fs.unlinkSync,
    logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logs.push(args));
  t.mock.method(
    fs,
    "unlinkSync",
    (target: Parameters<typeof fs.unlinkSync>[0]) => {
      if (typeof target === "string" && dirname(target) === directory)
        throw Object.assign(new Error("isolated failure"), { code: "EACCES" });
      return originalUnlink(target);
    },
  );
  syncBuiltinESMExports();
  try {
    assert.equal((await f.author(path, input)).status, 500);
    assert.deepEqual((await f.author(`/diaries/${diary.id}`)).data, diary);
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    assert.deepEqual(
      logs.find(([label]) => label === "Attachment compensation failed:")?.[1],
      {
        attachmentId: files[0],
        phase: "complete-write",
        cleanupCode: "EACCES",
      },
    );
    for (const privateValue of [
      directory,
      input.name,
      input.base64,
      "私有内容",
    ])
      assert.equal(JSON.stringify(logs).includes(privateValue), false);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    const recovery = new DatabaseSync(f.databasePath);
    recovery.exec("DROP TRIGGER test_cleanup_failure");
    recovery.close();
    for (const file of await readdir(directory))
      originalUnlink(join(directory, file));
  }
  assert.equal((await f.author(path, input)).status, 201);
});

test("独占附件写入遇到已有文件不删除或覆盖原字节", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "daily-file-collision-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = localFiles(directory);
  const id = randomUUID();
  const original = Buffer.from("已存在的完整附件");
  files.write(id, original);
  assert.throws(() => files.write(id, Buffer.from("新字节")), {
    code: "EEXIST",
  });
  assert.deepEqual(files.read(id), original);
});
