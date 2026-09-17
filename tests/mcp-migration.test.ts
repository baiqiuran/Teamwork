import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./application.ts";

test("更高数据库版本被拒绝，失败迁移回滚并释放文件", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "daily-mcp-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "migration.sqlite");
  const newer = new DatabaseSync(path);
  newer.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES(999)",
  );
  newer.close();
  await assert.rejects(
    createApp({ databasePath: path, setupKey: "migration-fixture" }),
    /数据库版本高于/,
  );
  const unchanged = new DatabaseSync(path);
  assert.equal(
    unchanged
      .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table'")
      .get()!.count,
    1,
  );
  unchanged.close();
  await rm(path);
  const initial = await createApp({
    databasePath: path,
    setupKey: "migration-fixture",
  });
  await initial.close();
  const broken = new DatabaseSync(path);
  broken.exec(
    "DELETE FROM schema_migrations WHERE version>3; ALTER TABLE task_events RENAME COLUMN created_at TO deliberately_broken",
  );
  broken.close();
  await assert.rejects(
    createApp({ databasePath: path, setupKey: "migration-fixture" }),
    /created_at/,
  );
  const rolledBack = new DatabaseSync(path);
  assert.equal(
    rolledBack
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get()!.version,
    3,
  );
  assert.equal(
    rolledBack
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='task_events_before_mcp'",
      )
      .get(),
    undefined,
  );
  assert.ok(
    rolledBack
      .prepare("SELECT name FROM sqlite_master WHERE name='task_events'")
      .get(),
  );
  rolledBack.close();
  await rm(path);
});
