import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./application.ts";
import { legacy, seedLegacyTeam } from "./legacy-team-fixture.ts";

test("团队归属迁移遇到损坏关联时回滚原结构，修复测试材料后可正常启动", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "daily-team-migration-failure-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "legacy.sqlite");
  seedLegacyTeam(path);
  const broken = new DatabaseSync(path);
  try {
    broken.exec(
      "PRAGMA foreign_keys = OFF; INSERT INTO projects (id,name,description,created_by,created_at) VALUES ('orphan','损坏关联','','missing',1)",
    );
  } finally {
    broken.close();
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(
      createApp({ databasePath: path }),
      /关联检查失败/,
    );
    const after = new DatabaseSync(path);
    try {
      assert.equal(
        after
          .prepare("SELECT MAX(version) AS version FROM schema_migrations")
          .get()!.version,
        7,
      );
      assert.deepEqual(
        after
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('team_next','members_next')",
          )
          .all(),
        [],
      );
      assert.equal(
        after
          .prepare("PRAGMA table_info(members)")
          .all()
          .some((column) => column.name === "team_id"),
        false,
      );
      assert.equal(
        after.prepare("SELECT email FROM members").get()!.email,
        legacy.member.email,
      );
    } finally {
      after.close();
    }
  }
  const repaired = new DatabaseSync(path);
  try {
    repaired
      .prepare("UPDATE projects SET created_by=? WHERE id='orphan'")
      .run(legacy.member.id);
  } finally {
    repaired.close();
  }
  const app = await createApp({
    databasePath: path,
    now: () => legacy.at,
  });
  try {
    const server = await app.listen(0);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/me`, {
      headers: {
        Cookie: `daily_session=${legacy.session}`,
        Connection: "close",
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).team, legacy.team);
  } finally {
    await app.close();
  }
});

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
    createApp({ databasePath: path }),
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
  });
  await initial.close();
  const broken = new DatabaseSync(path);
  broken.exec(
    "DELETE FROM schema_migrations WHERE version>3; ALTER TABLE task_events RENAME COLUMN created_at TO deliberately_broken",
  );
  broken.close();
  await assert.rejects(
    createApp({ databasePath: path }),
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
