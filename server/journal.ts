import type { Express, Request } from "express";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError } from "./http-error.ts";

const text = (max: number) =>
  z.string().refine((value) => [...value].length <= max, `最多 ${max} 字`);
const entrySchema = z.object({ id: z.uuid(), body: text(10_000) });
const contentSchema = z
  .object({ title: text(100), entries: z.array(entrySchema).max(50) })
  .refine(
    (value) =>
      new Set(value.entries.map((e) => e.id)).size === value.entries.length,
    "条目标识不能重复",
  );
export type Content = z.infer<typeof contentSchema>;
interface DiaryRow {
  id: string;
  author_id: string;
  draft: string;
  version: number;
  created_at: number;
  updated_at: number;
}
export interface JournalContext {
  db: DatabaseSync;
  now: () => number;
  authenticate: (request: Request) => { id: string; name: string };
  transaction: <T>(work: () => T) => T;
}
export function installJournal(
  app: Express,
  { db, now, authenticate }: JournalContext,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS diaries (
    id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES members(id), draft TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );`);
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
      diaryDate: null,
    };
  }
  function checkVersion(row: DiaryRow, version: unknown) {
    if (version !== row.version)
      throw new HttpError(
        409,
        "这份日报已在其他窗口更新，请重新打开后再编辑。",
      );
  }
  app.post("/api/diaries", (request, response) => {
    const member = authenticate(request);
    const content = contentSchema.parse(request.body);
    const id = randomUUID();
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
    checkVersion(row, request.body.version);
    const content = contentSchema.parse(request.body);
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
    const row = owned(request);
    checkVersion(row, request.body.version);
    db.prepare("DELETE FROM diaries WHERE id = ?").run(row.id);
    response.json({ ok: true });
  });
}
