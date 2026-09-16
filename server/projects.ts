import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError } from "./http-error.ts";
import type { JournalContext, Content } from "./journal.ts";
import { dateRange, readPublished } from "./published.ts";
const definition = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(10_000),
});
export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  created_by: string;
  created_at: number;
  archived: number;
}
export function installProjects(
  app: Express,
  { db, now, authenticate }: JournalContext,
) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES members(id), created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0);`,
  );
  const creator = (id: string) =>
    db.prepare("SELECT id, name FROM members WHERE id = ?").get(id);
  function project(id: string) {
    const row = db
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(id) as unknown as ProjectRow | undefined;
    if (!row) throw new HttpError(404, "未找到项目。");
    return row;
  }
  const view = (row: ProjectRow) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    creator: creator(row.created_by),
    createdAt: row.created_at,
    archived: !!row.archived,
  });
  app.get("/api/projects", (req, res) => {
    authenticate(req);
    res.json(
      (
        db
          .prepare("SELECT * FROM projects ORDER BY created_at DESC, id")
          .all() as unknown as ProjectRow[]
      ).map(view),
    );
  });
  app.post("/api/projects", (req, res) => {
    const member = authenticate(req);
    const input = definition.parse(req.body);
    const id = randomUUID();
    db.prepare(
      "INSERT INTO projects (id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, input.name, input.description, member.id, now());
    res.status(201).json(view(project(id)));
  });
  app.get("/api/projects/:id", (req, res) => {
    authenticate(req);
    res.json(view(project(z.uuid().parse(req.params.id))));
  });
  app.post("/api/projects/:id/save", (req, res) => {
    const member = authenticate(req);
    const row = project(z.uuid().parse(req.params.id));
    if (row.created_by !== member.id)
      throw new HttpError(403, "只有创建者可修改项目资料。");
    const input = definition.parse(req.body);
    db.prepare(
      "UPDATE projects SET name = ?, description = ? WHERE id = ?",
    ).run(input.name, input.description, row.id);
    res.json(view(project(row.id)));
  });
  app.get("/api/projects/:id/progress", (req, res) => {
    authenticate(req);
    const row = project(z.uuid().parse(req.params.id));
    res.json(readPublished(db, dateRange(req.query), { projectId: row.id }));
  });
  function prepareEntries(content: Content) {
    for (const entry of content.entries) {
      if (!entry.projectId) continue;
      const row = project(entry.projectId);
      if (row.archived)
        throw new HttpError(409, "项目已归档，请调整工作条目关联。");
      entry.projectName = row.name;
    }
    return content;
  }
  return { prepareEntries };
}
