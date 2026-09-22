import type { DatabaseSync } from "node:sqlite";
import { teamNameKey } from "../../shared/domain/team-name.ts";

const latestVersion = 8;

export function assertAiVersion(db: DatabaseSync) {
  const exists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    )
    .get();
  if (
    exists &&
    Number(
      db
        .prepare(
          "SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations",
        )
        .get()!.version,
    ) > latestVersion
  )
    throw new Error("数据库版本高于当前程序，请使用匹配版本或恢复备份。");
}
export function migrateAi(db: DatabaseSync) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)",
  );
  const current = Number(
    db
      .prepare(
        "SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations",
      )
      .get()!.version,
  );
  if (current > latestVersion)
    throw new Error("数据库版本高于当前程序，请使用匹配版本或恢复备份。");
  if (current === latestVersion) return;
  // Table replacement requires disabling FK enforcement before BEGIN and checking it before COMMIT.
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (current < 1)
      db.exec(`
      CREATE TABLE ai_grants (id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), client_id TEXT NOT NULL, resource TEXT NOT NULL, scopes TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE TABLE ai_codes (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES ai_grants(id), redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE ai_access (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES ai_grants(id), expires_at INTEGER NOT NULL);
      INSERT INTO schema_migrations (version) VALUES (1);
    `);
    if (current < 2)
      db.exec(`
      ALTER TABLE ai_grants ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0;
      UPDATE ai_grants SET last_used_at=created_at;
      CREATE TABLE ai_refresh (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES ai_grants(id));
      INSERT INTO schema_migrations (version) VALUES (2);
    `);
    if (current < 3)
      db.exec(`
      CREATE TABLE ai_receipts (member_id TEXT NOT NULL REFERENCES members(id), operation_id TEXT NOT NULL, tool TEXT NOT NULL, fingerprint TEXT NOT NULL, grant_id TEXT NOT NULL REFERENCES ai_grants(id), result TEXT NOT NULL, PRIMARY KEY(member_id,operation_id));
      CREATE TABLE ai_operations (id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), grant_id TEXT NOT NULL REFERENCES ai_grants(id), client_id TEXT NOT NULL, tool TEXT NOT NULL, object_id TEXT, at INTEGER NOT NULL, outcome TEXT NOT NULL, error_code TEXT);
      CREATE INDEX ai_operations_member_time ON ai_operations(member_id,at,id);
      INSERT INTO schema_migrations (version) VALUES (3);
    `);
    if (current < 4)
      db.exec(`
      ALTER TABLE task_events RENAME TO task_events_before_mcp;
      CREATE TABLE task_events (id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),diary_id TEXT,member_id TEXT NOT NULL REFERENCES members(id),before_status TEXT NOT NULL,after_status TEXT NOT NULL,created_at INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('diary','direct')),channel TEXT NOT NULL CHECK(channel IN ('web','mcp')),CHECK((kind='diary' AND diary_id IS NOT NULL) OR (kind='direct' AND diary_id IS NULL)));
      INSERT INTO task_events (id,task_id,diary_id,member_id,before_status,after_status,created_at,kind,channel) SELECT id,task_id,diary_id,member_id,before_status,after_status,created_at,'diary','web' FROM task_events_before_mcp ORDER BY rowid;
      DROP TABLE task_events_before_mcp;
      INSERT INTO schema_migrations (version) VALUES (4);
    `);
    if (current < 5)
      db.exec(
        "ALTER TABLE ai_receipts ADD COLUMN scopes TEXT NOT NULL DEFAULT '[]'; INSERT INTO schema_migrations (version) VALUES (5);",
      );
    if (current < 6)
      db.exec(
        "CREATE TABLE ai_clients (id TEXT PRIMARY KEY,name TEXT NOT NULL,redirect_uris TEXT NOT NULL); INSERT INTO schema_migrations (version) VALUES (6);",
      );
    if (current < 7)
      db.exec(`
        ALTER TABLE ai_grants ADD COLUMN credential_type TEXT NOT NULL DEFAULT 'oauth' CHECK(credential_type IN ('oauth','api-key'));
        ALTER TABLE ai_grants ADD COLUMN name TEXT;
        CREATE TABLE ai_api_keys (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL UNIQUE REFERENCES ai_grants(id));
        INSERT INTO schema_migrations (version) VALUES (7);
      `);
    if (current < 8) {
      const teams = db.prepare("SELECT id, name FROM team").all();
      const hasMembers = db.prepare("SELECT 1 FROM members LIMIT 1").get();
      if (teams.length > 1 || (hasMembers && teams.length !== 1))
        throw new Error("原账号缺少唯一团队归属，迁移已取消。");
      db.exec(`
        CREATE TABLE team_next (id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE);
        CREATE TABLE members_next (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, team_id INTEGER NOT NULL REFERENCES team(id));
      `);
      for (const team of teams)
        db.prepare(
          "INSERT INTO team_next (id, name, name_key) VALUES (?, ?, ?)",
        ).run(team.id, team.name, teamNameKey(String(team.name)));
      if (teams.length === 1)
        db.prepare(
          `INSERT INTO members_next (rowid, id, name, email, password_hash, created_at, team_id)
          SELECT rowid, id, name, email, password_hash, created_at, ? FROM members`,
        ).run(teams[0].id);
      // Do not rename the old tables: that would rewrite dependent FK targets.
      db.exec(`
        DROP TABLE members;
        DROP TABLE team;
        ALTER TABLE team_next RENAME TO team;
        ALTER TABLE members_next RENAME TO members;
        CREATE INDEX members_team ON members(team_id);
        INSERT INTO schema_migrations (version) VALUES (8);
      `);
    }
    if (db.prepare("PRAGMA foreign_key_check").get())
      throw new Error("数据库关联检查失败，迁移已取消。");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
