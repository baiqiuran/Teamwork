import { DatabaseSync } from "node:sqlite";
import type { Runtime } from "../../application/ports.ts";

export function openDatabase(path: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS team (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, created_by TEXT NOT NULL REFERENCES members(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, used_by TEXT REFERENCES members(id));
    CREATE TABLE IF NOT EXISTS diaries (id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES members(id), draft TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS diary_events (diary_id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), action TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS submission_receipts (member_id TEXT NOT NULL, request_id TEXT NOT NULL, diary_id TEXT NOT NULL, input_version INTEGER NOT NULL, result TEXT NOT NULL, PRIMARY KEY(member_id, request_id));
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES members(id), created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, description TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES members(id), created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS task_events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), diary_id TEXT NOT NULL, member_id TEXT NOT NULL REFERENCES members(id), before_status TEXT NOT NULL, after_status TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, diary_id TEXT NOT NULL, entry_id TEXT NOT NULL, member_id TEXT NOT NULL REFERENCES members(id), name TEXT NOT NULL, size INTEGER NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, UNIQUE(member_id, request_id));
    CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL REFERENCES members(id), type TEXT NOT NULL, from_date TEXT NOT NULL, to_date TEXT NOT NULL, created_at INTEGER NOT NULL, closed_at INTEGER);
  `);
    // Keep additive migrations compatible with databases created by earlier releases.
    for (const [table, additions] of Object.entries({
      diaries: {
        published: "TEXT",
        first_at: "INTEGER",
        submitted_at: "INTEGER",
        diary_date: "TEXT",
      },
      shares: {
        target_id: "TEXT",
        modules: `TEXT NOT NULL DEFAULT '["progress"]'`,
      },
    })) {
      const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name);
      for (const [name, type] of Object.entries(additions)) {
        if (!columns.includes(name))
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
    }
    const transaction: Runtime["transaction"] = (work) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const value = work();
        if (value && typeof value === "object" && "then" in value)
          throw new Error("SQLite transactions must be synchronous");
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    };
    return { db, transaction, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}
