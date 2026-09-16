import type { Express, Request } from "express";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError } from "./http-error.ts";
import { installAttachments } from "./attachments.ts";
import { installProjects } from "./projects.ts";
import { dateRange, readPublished } from "./published.ts";

const text = (max: number) =>
  z.string().refine((value) => [...value].length <= max, `最多 ${max} 字`);
const entrySchema = z.object({
  id: z.uuid(),
  body: text(10_000),
  attachments: z
    .array(
      z.object({
        id: z.uuid(),
        name: z.string().optional(),
        size: z.number().optional(),
      }),
    )
    .max(10)
    .optional(),
  projectId: z.uuid().optional(),
  projectName: z.string().optional(),
  taskId: z.uuid().optional(),
  newTask: z
    .object({ name: z.string().max(100), description: text(10_000) })
    .optional(),
  taskName: z.string().optional(),
  taskStatus: z.enum(["pending", "in-progress", "done"]).optional(),
  statusChange: z
    .object({
      status: z.enum(["pending", "in-progress", "done"]),
      expectedVersion: z.number().int().positive(),
      resolution: z.enum(["keep", "apply"]).optional(),
    })
    .optional(),
});
const contentSchema = z
  .object({ title: text(100), entries: z.array(entrySchema).max(50) })
  .refine(
    (value) =>
      new Set(value.entries.map((e) => e.id)).size === value.entries.length,
    "条目标识不能重复",
  );
export type Content = z.infer<typeof contentSchema>;
export interface DiaryRow {
  id: string;
  author_id: string;
  draft: string;
  version: number;
  created_at: number;
  updated_at: number;
  published: string | null;
  first_at: number | null;
  submitted_at: number | null;
  diary_date: string | null;
}
export interface JournalContext {
  db: DatabaseSync;
  now: () => number;
  authenticate: (request: Request) => { id: string; name: string };
  transaction: <T>(work: () => T) => T;
}
export function installJournal(
  app: Express,
  { db, now, authenticate, transaction }: JournalContext,
  attachmentDirectory: string,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS diaries (
    id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES members(id), draft TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );`);
  db.exec(
    `CREATE TABLE IF NOT EXISTS diary_events (diary_id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), action TEXT NOT NULL, created_at INTEGER NOT NULL);`,
  );
  const projects = installProjects(app, { db, now, authenticate, transaction });
  const columns = db
    .prepare("PRAGMA table_info(diaries)")
    .all()
    .map((row) => row.name);
  for (const [name, type] of [
    ["published", "TEXT"],
    ["first_at", "INTEGER"],
    ["submitted_at", "INTEGER"],
    ["diary_date", "TEXT"],
  ]) {
    if (!columns.includes(name))
      db.exec(`ALTER TABLE diaries ADD COLUMN ${name} ${type}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS submission_receipts (
    member_id TEXT NOT NULL, request_id TEXT NOT NULL, diary_id TEXT NOT NULL,
    input_version INTEGER NOT NULL, result TEXT NOT NULL, PRIMARY KEY(member_id, request_id)
  );`);
  const dateToday = () =>
    new Date(now() + 8 * 3600_000).toISOString().slice(0, 10);
  function writable(row: DiaryRow) {
    if (row.diary_date && row.diary_date !== dateToday())
      throw new HttpError(409, "历史日报已锁定，不能修改、重新提交或删除。");
  }
  function publicView(row: DiaryRow) {
    return {
      id: row.id,
      author: db
        .prepare("SELECT id, name FROM members WHERE id = ?")
        .get(row.author_id),
      published: JSON.parse(row.published!),
      diaryDate: row.diary_date,
      firstSubmittedAt: row.first_at,
      submittedAt: row.submitted_at,
    };
  }
  function owned(request: Request) {
    const member = authenticate(request);
    const row = db
      .prepare("SELECT * FROM diaries WHERE id = ? AND author_id = ?")
      .get(z.uuid().parse(request.params.id), member.id) as unknown as
      DiaryRow | undefined;
    if (!row) throw new HttpError(404, "未找到日报。");
    return row;
  }
  function view(row: DiaryRow) {
    return {
      id: row.id,
      authorId: row.author_id,
      draft: JSON.parse(row.draft) as Content,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      diaryDate: row.diary_date,
      published: row.published ? JSON.parse(row.published) : null,
      firstSubmittedAt: row.first_at,
      submittedAt: row.submitted_at,
      editable: !row.diary_date || row.diary_date === dateToday(),
    };
  }
  function checkVersion(row: DiaryRow, version: unknown) {
    if (version !== row.version)
      throw new HttpError(
        409,
        "这份日报已在其他窗口更新，请重新打开后再编辑。",
      );
  }
  const attachments = installAttachments(
    app,
    { db, now, authenticate, transaction },
    { owned, writable, checkVersion, view },
    attachmentDirectory,
  );
  app.post("/api/diaries", (request, response) => {
    const member = authenticate(request);
    const content = contentSchema.parse(request.body);
    const id = randomUUID();
    attachments.normalize(content, id, member.id);
    db.prepare(
      "INSERT INTO diaries (id, author_id, draft, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, member.id, JSON.stringify(content), now(), now());
    response
      .status(201)
      .json(
        view(
          db
            .prepare("SELECT * FROM diaries WHERE id = ?")
            .get(id) as unknown as DiaryRow,
        ),
      );
  });
  app.get("/api/diaries/mine", (request, response) => {
    const member = authenticate(request);
    response.json(
      (
        db
          .prepare(
            "SELECT * FROM diaries WHERE author_id = ? ORDER BY updated_at DESC, rowid DESC",
          )
          .all(member.id) as unknown as DiaryRow[]
      ).map(view),
    );
  });
  app.get("/api/diaries/:id", (request, response) =>
    response.json(view(owned(request))),
  );
  app.post("/api/diaries/:id/save", (request, response) => {
    const row = owned(request);
    writable(row);
    checkVersion(row, request.body.version);
    const content = contentSchema.parse(request.body);
    attachments.normalize(content, row.id, row.author_id);
    db.prepare(
      "UPDATE diaries SET draft = ?, version = version + 1, updated_at = ? WHERE id = ?",
    ).run(JSON.stringify(content), now(), row.id);
    response.json(
      view({
        ...row,
        draft: JSON.stringify(content),
        version: row.version + 1,
        updated_at: now(),
      }),
    );
  });
  app.post("/api/diaries/:id/delete", (request, response) => {
    const member = authenticate(request);
    const deleted = db
      .prepare(
        "SELECT * FROM diary_events WHERE diary_id = ? AND member_id = ?",
      )
      .get(z.uuid().parse(request.params.id), member.id);
    if (deleted) {
      response.json({ ok: true });
      return;
    }
    const row = owned(request);
    writable(row);
    checkVersion(row, request.body.version);
    transaction(() => {
      if (row.published)
        db.prepare("INSERT INTO diary_events VALUES (?, ?, ?, ?)").run(
          row.id,
          member.id,
          "delete",
          now(),
        );
      db.prepare("DELETE FROM diaries WHERE id = ?").run(row.id);
    });
    response.json({ ok: true });
  });
  app.get("/api/diary-events", (request, response) => {
    authenticate(request);
    response.json(
      db
        .prepare("SELECT * FROM diary_events ORDER BY created_at DESC")
        .all()
        .map((row) => ({
          diaryId: row.diary_id,
          action: row.action,
          at: row.created_at,
          member: db
            .prepare("SELECT id, name FROM members WHERE id = ?")
            .get(row.member_id),
        })),
    );
  });
  app.post("/api/diaries/:id/submit", (request, response) => {
    const member = authenticate(request);
    const input = z
      .object({ version: z.number().int(), requestId: z.uuid() })
      .parse(request.body);
    const result = transaction(() => {
      const receipt = db
        .prepare(
          "SELECT * FROM submission_receipts WHERE member_id = ? AND request_id = ?",
        )
        .get(member.id, input.requestId);
      if (receipt) {
        if (
          receipt.diary_id !== request.params.id ||
          receipt.input_version !== input.version
        )
          throw new HttpError(409, "提交标识已使用，请重新提交。");
        return JSON.parse(String(receipt.result));
      }
      const row = owned(request);
      writable(row);
      checkVersion(row, input.version);
      const content = contentSchema.parse(JSON.parse(row.draft));
      attachments.normalize(content, row.id, member.id);
      content.entries = content.entries.filter(
        (entry) => entry.body.trim() || entry.attachments?.length,
      );
      if (!content.entries.length)
        throw new HttpError(400, "请至少填写一条工作内容后再提交。");
      projects.prepareEntries(content, member.id);
      projects.updateTaskStatuses(content, member.id, row.id);
      const timestamp = now();
      const published = JSON.stringify(content);
      db.prepare(
        "UPDATE diaries SET published = ?, draft = ?, first_at = COALESCE(first_at, ?), diary_date = COALESCE(diary_date, ?), submitted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?",
      ).run(
        published,
        published,
        timestamp,
        dateToday(),
        timestamp,
        timestamp,
        row.id,
      );
      const result = view(
        db
          .prepare("SELECT * FROM diaries WHERE id = ?")
          .get(row.id) as unknown as DiaryRow,
      );
      db.prepare("INSERT INTO submission_receipts VALUES (?, ?, ?, ?, ?)").run(
        member.id,
        input.requestId,
        row.id,
        input.version,
        JSON.stringify(result),
      );
      return result;
    });
    response.json(result);
  });
  app.get("/api/team-diaries", (request, response) => {
    authenticate(request);
    response.json(
      readPublished(db, dateRange(request.query), {
        memberId: request.query.memberId
          ? z.uuid().parse(request.query.memberId)
          : undefined,
        projectId: request.query.projectId
          ? z.uuid().parse(request.query.projectId)
          : undefined,
        complete: true,
      }),
    );
  });
  app.get("/api/members", (request, response) => {
    authenticate(request);
    response.json(
      db.prepare("SELECT id, name FROM members ORDER BY name, id").all(),
    );
  });
  app.get("/api/team-diaries/:id", (request, response) => {
    authenticate(request);
    const row = db
      .prepare("SELECT * FROM diaries WHERE id = ? AND published IS NOT NULL")
      .get(z.uuid().parse(request.params.id)) as unknown as
      DiaryRow | undefined;
    if (!row) throw new HttpError(404, "未找到已提交日报。");
    response.json(publicView(row));
  });
}
