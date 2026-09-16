import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { secret } from "./security.ts";
import { HttpError } from "./http-error.ts";
import type { JournalContext } from "./journal.ts";
import {
  availableShare,
  readShareProgress,
  type ShareRow,
} from "./share-access.ts";
import type { ProjectRow, TaskRow } from "./projects.ts";
export function installSharing(
  app: Express,
  { db, now, authenticate }: JournalContext,
) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL REFERENCES members(id), type TEXT NOT NULL, from_date TEXT NOT NULL, to_date TEXT NOT NULL, created_at INTEGER NOT NULL, closed_at INTEGER);`,
  );
  const columns = db
    .prepare("PRAGMA table_info(shares)")
    .all()
    .map((row) => row.name);
  if (!columns.includes("target_id"))
    db.exec("ALTER TABLE shares ADD COLUMN target_id TEXT");
  if (!columns.includes("modules"))
    db.exec(
      `ALTER TABLE shares ADD COLUMN modules TEXT NOT NULL DEFAULT '["progress"]'`,
    );
  const member = (id: string) =>
    db.prepare("SELECT id, name FROM members WHERE id = ?").get(id);
  function target(type: ShareRow["type"], id: string | null) {
    if (type === "diary") return null;
    const table = type === "project" ? "projects" : "tasks";
    const row = db
      .prepare(`SELECT * FROM ${table} WHERE id = ?`)
      .get(id) as unknown as ProjectRow | TaskRow | undefined;
    if (!row) throw new HttpError(404, "未找到分享对象。");
    return row;
  }
  const view = (s: ShareRow) => ({
    id: s.id,
    token: s.token,
    type: s.type,
    targetId: s.target_id,
    targetName: target(s.type, s.target_id)?.name ?? "全团队日报",
    modules: JSON.parse(s.modules),
    from: s.from_date,
    to: s.to_date,
    createdAt: s.created_at,
    closed: s.closed_at !== null,
    path: `/share/${s.token}`,
  });
  function taskScope(
    row: ShareRow,
    records: ReturnType<typeof readShareProgress>,
  ) {
    const all = db
      .prepare("SELECT * FROM tasks ORDER BY created_at, id")
      .all() as unknown as TaskRow[];
    const referenced = new Set(
      records.flatMap((r) =>
        r.published.entries.flatMap((e) => (e.taskId ? [e.taskId] : [])),
      ),
    );
    return all.filter((t) =>
      row.type === "project"
        ? t.project_id === row.target_id
        : row.type === "task"
          ? t.id === row.target_id
          : referenced.has(t.id),
    );
  }
  app.post("/api/shares", (req, res) => {
    const owner = authenticate(req);
    const input = z
      .object({
        type: z.enum(["diary", "project", "task"]),
        targetId: z.uuid().optional(),
        from: z.iso.date(),
        to: z.iso.date(),
        modules: z
          .array(z.enum(["overview", "tasks", "progress"]))
          .min(1)
          .max(3)
          .default(["progress"]),
      })
      .parse(req.body);
    if (input.from > input.to)
      throw new HttpError(400, "开始日期不能晚于结束日期。");
    if (input.type !== "diary" && !input.targetId)
      throw new HttpError(400, "请选择分享对象。");
    const selected = target(input.type, input.targetId ?? null);
    if (
      selected?.archived ||
      (selected &&
        "project_id" in selected &&
        target("project", String(selected.project_id))?.archived)
    )
      throw new HttpError(409, "归档对象不能生成公开链接。");
    const id = randomUUID(),
      token = secret();
    db.prepare(
      "INSERT INTO shares (id, token, created_by, type, target_id, modules, from_date, to_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      token,
      owner.id,
      input.type,
      input.type === "diary" ? null : input.targetId!,
      JSON.stringify([...new Set(input.modules)]),
      input.from,
      input.to,
      now(),
    );
    res.status(201).json(view(availableShare(db, token)));
  });
  app.get("/api/shares", (req, res) => {
    const owner = authenticate(req);
    res.json(
      (
        db
          .prepare(
            "SELECT * FROM shares WHERE created_by = ? ORDER BY created_at DESC, rowid DESC",
          )
          .all(owner.id) as unknown as ShareRow[]
      ).map(view),
    );
  });
  app.post("/api/shares/:id/close", (req, res) => {
    const owner = authenticate(req);
    const row = db
      .prepare("SELECT * FROM shares WHERE id = ?")
      .get(z.uuid().parse(req.params.id)) as unknown as ShareRow | undefined;
    if (!row) throw new HttpError(404, "未找到分享。");
    if (row.created_by !== owner.id)
      throw new HttpError(403, "只有生成者可以关闭链接。");
    db.prepare(
      "UPDATE shares SET closed_at = COALESCE(closed_at, ?) WHERE id = ?",
    ).run(now(), row.id);
    res.json({ ok: true });
  });
  app.get("/api/public/:token", (req, res) => {
    const row = availableShare(db, z.string().max(128).parse(req.params.token));
    const modules: string[] = JSON.parse(row.modules);
    const records = readShareProgress(db, row),
      tasks = taskScope(row, records);
    const selected = target(row.type, row.target_id);
    res.json({
      type: row.type,
      from: row.from_date,
      to: row.to_date,
      modules,
      ...(modules.includes("overview")
        ? {
            overview: {
              name: selected?.name ?? "全团队日报",
              description:
                selected?.description ?? "所选日期内全团队成员的完整已提交日报",
              creator: selected ? member(selected.created_by) : undefined,
              diaryCount: records.length,
              entryCount: records.reduce(
                (n, r) => n + r.published.entries.length,
                0,
              ),
              taskCount: tasks.length,
            },
          }
        : {}),
      ...(modules.includes("progress") ? { progress: records } : {}),
      ...(modules.includes("tasks")
        ? {
            tasks: tasks.map((t) => ({
              id: t.id,
              name: t.name,
              description: t.description,
              creator: member(t.created_by),
              status: t.status,
              archived: !!t.archived,
            })),
          }
        : {}),
    });
  });
}
