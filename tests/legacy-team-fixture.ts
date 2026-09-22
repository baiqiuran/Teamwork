import { DatabaseSync } from "node:sqlite";
import { createHash, scryptSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const legacy = {
  team: { id: 1, name: "  Ｔｅａｍ 研发  " },
  member: {
    id: "10000000-0000-4000-8000-000000000001",
    name: "原成员",
    email: "legacy@example.test",
  },
  password: "LegacyFixture2026!",
  session: "legacy-valid-session",
  at: Date.parse("2026-09-16T03:00:00Z"),
  joinedAt: Date.parse("2026-08-01T03:00:00Z"),
};
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function seedLegacyAuthorization(path: string, origin: string) {
  seedLegacyTeam(path);
  const db = new DatabaseSync(path);
  try {
    for (const [suffix, type, revoked, expires] of [
      ["key", "api-key", null, null],
      ["oauth", "oauth", null, legacy.at + 86400000],
      ["revoked-key", "api-key", legacy.at, null],
      ["revoked-oauth", "oauth", legacy.at, legacy.at + 86400000],
      ["expired-oauth", "oauth", null, legacy.at - 1],
    ] as const) {
      const id = `legacy-${suffix}`;
      db.prepare(
        "INSERT INTO ai_grants (id,member_id,client_id,resource,scopes,created_at,revoked_at,last_used_at,credential_type,name) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        legacy.member.id,
        "daily-flow-codex",
        `${origin}/mcp`,
        '["progress:read","tasks:write"]',
        legacy.at,
        revoked,
        legacy.at,
        type,
        type === "api-key" ? id : null,
      );
      if (type === "api-key")
        db.prepare("INSERT INTO ai_api_keys (hash,grant_id) VALUES (?,?)").run(
          digest(`dfk_${id}`),
          id,
        );
      else {
        db.prepare(
          "INSERT INTO ai_access (hash,grant_id,expires_at) VALUES (?,?,?)",
        ).run(digest(id), id, expires);
        db.prepare("INSERT INTO ai_refresh (hash,grant_id) VALUES (?,?)").run(
          digest(`${id}-refresh`),
          id,
        );
      }
    }
  } finally {
    db.close();
  }
}

export const oldIds = {
  colleague: "10000000-0000-4000-8000-000000000002",
  project: "20000000-0000-4000-8000-000000000001",
  task: "30000000-0000-4000-8000-000000000001",
  diary: "40000000-0000-4000-8000-000000000001",
  draft: "40000000-0000-4000-8000-000000000002",
  entry: "50000000-0000-4000-8000-000000000001",
  attachment: "60000000-0000-4000-8000-000000000001",
  event: "70000000-0000-4000-8000-000000000001",
  directEvent: "70000000-0000-4000-8000-000000000002",
  request: "80000000-0000-4000-8000-000000000001",
  operation: "80000000-0000-4000-8000-000000000002",
  audit: "90000000-0000-4000-8000-000000000001",
};
export const oldContent = {
  title: "原日报",
  entries: [
    {
      id: oldIds.entry,
      body: "迁移前已完成的工作",
      projectId: oldIds.project,
      projectName: "原项目",
      taskId: oldIds.task,
      taskName: "原任务",
      taskStatus: "in-progress",
      attachments: [{ id: oldIds.attachment, name: "原附件.txt", size: 18 }],
    },
  ],
};
export const oldSubmission = {
  id: oldIds.diary,
  authorId: legacy.member.id,
  draft: oldContent,
  published: oldContent,
  version: 2,
  createdAt: legacy.at,
  updatedAt: legacy.at,
  firstSubmittedAt: legacy.at,
  submittedAt: legacy.at,
  diaryDate: "2026-09-16",
  editable: true,
};
export const oldTask = {
  id: oldIds.task,
  projectId: oldIds.project,
  name: "原任务",
  description: "原任务说明",
  creator: { id: legacy.member.id, name: legacy.member.name },
  createdAt: legacy.at,
  archived: false,
  status: "done",
  version: 3,
};
export const oldOperation = {
  description: "原任务说明",
  name: "原任务",
  operationId: oldIds.operation,
  projectId: oldIds.project,
};

export async function seedLegacyWork(path: string, origin: string) {
  seedLegacyAuthorization(path, origin);
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.prepare(
      "INSERT INTO members (id,name,email,password_hash,created_at) SELECT ?,?,?,password_hash,created_at FROM members WHERE id=?",
    ).run(
      oldIds.colleague,
      "原同事",
      "colleague@example.test",
      legacy.member.id,
    );
    db.prepare(
      "INSERT INTO sessions (token_hash,member_id,expires_at) VALUES (?,?,?)",
    ).run(
      digest("legacy-colleague-session"),
      oldIds.colleague,
      legacy.at + 7 * 86400000,
    );
    const invitation = db.prepare(
      "INSERT INTO invitations (id,token_hash,created_by,created_at,expires_at,revoked_at,used_by) VALUES (?,?,?,?,?,?,?)",
    );
    for (const [id, revoked, used, expires] of [
      ["active", null, null, legacy.at + 7 * 86400000],
      ["revoked", legacy.at, null, legacy.at + 7 * 86400000],
      ["used", null, oldIds.colleague, legacy.at + 7 * 86400000],
      ["expired", null, null, legacy.at - 1],
    ] as const)
      invitation.run(
        id,
        digest(`invite-${id}`),
        legacy.member.id,
        Number(expires) - 7 * 86400000,
        expires,
        revoked,
        used,
      );
    db.prepare(
      "INSERT INTO projects (id,name,description,created_by,created_at) VALUES (?,?,?,?,?)",
    ).run(
      oldIds.project,
      "原项目",
      "迁移前项目说明",
      legacy.member.id,
      legacy.at,
    );
    db.prepare(
      "INSERT INTO tasks (id,project_id,name,description,created_by,created_at,status,version) VALUES (?,?,?,?,?,?,?,?)",
    ).run(
      oldIds.task,
      oldIds.project,
      "原任务",
      "原任务说明",
      legacy.member.id,
      legacy.at,
      "done",
      3,
    );
    db.prepare(
      "INSERT INTO diaries (id,author_id,draft,version,created_at,updated_at,published,first_at,submitted_at,diary_date) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(
      oldIds.diary,
      legacy.member.id,
      JSON.stringify({ ...oldContent, title: "原日报待重提" }),
      3,
      legacy.at,
      legacy.at + 1000,
      JSON.stringify(oldContent),
      legacy.at,
      legacy.at,
      "2026-09-16",
    );
    db.prepare(
      "INSERT INTO diaries (id,author_id,draft,version,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    ).run(
      oldIds.draft,
      legacy.member.id,
      JSON.stringify({
        title: "原私人草稿",
        entries: [{ id: oldIds.entry, body: "未提交的原内容" }],
      }),
      1,
      legacy.at,
      legacy.at,
    );
    db.prepare(
      "INSERT INTO attachments (id,diary_id,entry_id,member_id,name,size,request_id,fingerprint) VALUES (?,?,?,?,?,?,?,?)",
    ).run(
      oldIds.attachment,
      oldIds.diary,
      oldIds.entry,
      legacy.member.id,
      "原附件.txt",
      18,
      oldIds.request,
      "legacy-upload",
    );
    db.prepare(
      "INSERT INTO task_events (id,task_id,diary_id,member_id,before_status,after_status,created_at,kind,channel) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      oldIds.event,
      oldIds.task,
      oldIds.diary,
      legacy.member.id,
      "pending",
      "in-progress",
      legacy.at,
      "diary",
      "web",
    );
    db.prepare(
      "INSERT INTO task_events (id,task_id,diary_id,member_id,before_status,after_status,created_at,kind,channel) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      oldIds.directEvent,
      oldIds.task,
      null,
      oldIds.colleague,
      "in-progress",
      "done",
      legacy.at + 1000,
      "direct",
      "mcp",
    );
    db.prepare(
      "INSERT INTO diary_events (diary_id,member_id,action,created_at) VALUES (?,?,?,?)",
    ).run(
      "40000000-0000-4000-8000-000000000003",
      oldIds.colleague,
      "delete",
      legacy.at,
    );
    db.prepare(
      "INSERT INTO submission_receipts (member_id,request_id,diary_id,input_version,result) VALUES (?,?,?,?,?)",
    ).run(
      legacy.member.id,
      oldIds.request,
      oldIds.diary,
      1,
      JSON.stringify(oldSubmission),
    );
    for (const [type, target] of [
      ["diary", null],
      ["project", oldIds.project],
      ["task", oldIds.task],
    ] as const) {
      db.prepare(
        "INSERT INTO shares (id,token,created_by,type,from_date,to_date,created_at,closed_at,target_id,modules) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).run(
        `share-${type}`,
        `public-${type}`,
        legacy.member.id,
        type,
        "2026-09-16",
        "2026-09-16",
        legacy.at,
        null,
        target,
        '["overview","tasks","progress"]',
      );
    }
    db.prepare(
      "INSERT INTO shares (id,token,created_by,type,from_date,to_date,created_at,closed_at,modules) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      "share-closed",
      "public-closed",
      legacy.member.id,
      "diary",
      "2026-09-16",
      "2026-09-16",
      legacy.at,
      legacy.at + 1000,
      '["progress"]',
    );
    // Keys are already in canonical order in this historical receipt input.
    db.prepare(
      "INSERT INTO ai_receipts (member_id,operation_id,tool,fingerprint,grant_id,result,scopes) VALUES (?,?,?,?,?,?,?)",
    ).run(
      legacy.member.id,
      oldIds.operation,
      "create_task",
      digest(JSON.stringify(oldOperation)),
      "legacy-key",
      JSON.stringify({
        objectId: oldIds.task,
        executedAt: legacy.at,
        task: { ...oldTask, status: "pending", version: 1 },
      }),
      '["tasks:write"]',
    );
    db.prepare(
      "INSERT INTO ai_operations (id,member_id,grant_id,client_id,tool,object_id,at,outcome,error_code) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      oldIds.audit,
      legacy.member.id,
      "legacy-key",
      "daily-flow-codex",
      "create_task",
      oldIds.task,
      legacy.at,
      "success",
      null,
    );
  } finally {
    db.close();
  }
  const attachments = join(dirname(path), "attachments");
  await mkdir(attachments, { recursive: true });
  await writeFile(join(attachments, oldIds.attachment), "legacy attachment!");
}

// Frozen historical v7 schema, not the candidate's migration implementation.
// Only fixture preparation uses SQL; acceptance reads the running HTTP/MCP service.
export function seedLegacyTeam(path: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE team (id INTEGER PRIMARY KEY CHECK (id=1), name TEXT NOT NULL);
      CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), expires_at INTEGER NOT NULL);
      CREATE TABLE invitations (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, created_by TEXT NOT NULL REFERENCES members(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, used_by TEXT REFERENCES members(id));
      CREATE TABLE diaries (id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES members(id), draft TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published TEXT, first_at INTEGER, submitted_at INTEGER, diary_date TEXT);
      CREATE TABLE diary_events (diary_id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), action TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE submission_receipts (member_id TEXT NOT NULL, request_id TEXT NOT NULL, diary_id TEXT NOT NULL, input_version INTEGER NOT NULL, result TEXT NOT NULL, PRIMARY KEY(member_id, request_id));
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES members(id), created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, description TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES members(id), created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE task_events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), diary_id TEXT, member_id TEXT NOT NULL REFERENCES members(id), before_status TEXT NOT NULL, after_status TEXT NOT NULL, created_at INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('diary','direct')), channel TEXT NOT NULL CHECK(channel IN ('web','mcp')), CHECK((kind='diary' AND diary_id IS NOT NULL) OR (kind='direct' AND diary_id IS NULL)));
      CREATE TABLE attachments (id TEXT PRIMARY KEY, diary_id TEXT NOT NULL, entry_id TEXT NOT NULL, member_id TEXT NOT NULL REFERENCES members(id), name TEXT NOT NULL, size INTEGER NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, UNIQUE(member_id, request_id));
      CREATE TABLE shares (id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL REFERENCES members(id), type TEXT NOT NULL, from_date TEXT NOT NULL, to_date TEXT NOT NULL, created_at INTEGER NOT NULL, closed_at INTEGER, target_id TEXT, modules TEXT NOT NULL DEFAULT '["progress"]');
      CREATE TABLE ai_grants (id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), client_id TEXT NOT NULL, resource TEXT NOT NULL, scopes TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER, last_used_at INTEGER NOT NULL DEFAULT 0, credential_type TEXT NOT NULL DEFAULT 'oauth' CHECK(credential_type IN ('oauth','api-key')), name TEXT);
      CREATE TABLE ai_codes (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES ai_grants(id), redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE ai_access (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES ai_grants(id), expires_at INTEGER NOT NULL);
      CREATE TABLE ai_refresh (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES ai_grants(id));
      CREATE TABLE ai_receipts (member_id TEXT NOT NULL REFERENCES members(id), operation_id TEXT NOT NULL, tool TEXT NOT NULL, fingerprint TEXT NOT NULL, grant_id TEXT NOT NULL REFERENCES ai_grants(id), result TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(member_id,operation_id));
      CREATE TABLE ai_operations (id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), grant_id TEXT NOT NULL REFERENCES ai_grants(id), client_id TEXT NOT NULL, tool TEXT NOT NULL, object_id TEXT, at INTEGER NOT NULL, outcome TEXT NOT NULL, error_code TEXT);
      CREATE INDEX ai_operations_member_time ON ai_operations(member_id,at,id);
      CREATE TABLE ai_clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL);
      CREATE TABLE ai_api_keys (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL UNIQUE REFERENCES ai_grants(id));
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
      INSERT INTO schema_migrations VALUES (1),(2),(3),(4),(5),(6),(7);
    `);
    const salt = "0123456789abcdef0123456789abcdef";
    const hash = scryptSync(legacy.password, salt, 64, {
      N: 32768,
      r: 8,
      p: 3,
      maxmem: 64 * 1024 * 1024,
    }).toString("hex");
    db.prepare("INSERT INTO team (id,name) VALUES (?,?)").run(
      legacy.team.id,
      legacy.team.name,
    );
    db.prepare(
      "INSERT INTO members (id,name,email,password_hash,created_at) VALUES (?,?,?,?,?)",
    ).run(
      legacy.member.id,
      legacy.member.name,
      legacy.member.email,
      `${salt}:${hash}`,
      legacy.joinedAt,
    );
    const session = db.prepare(
      "INSERT INTO sessions (token_hash,member_id,expires_at) VALUES (?,?,?)",
    );
    session.run(
      digest(legacy.session),
      legacy.member.id,
      legacy.at + 7 * 86400000,
    );
    session.run(
      digest("legacy-expired-session"),
      legacy.member.id,
      legacy.at - 1,
    );
  } finally {
    db.close();
  }
}
