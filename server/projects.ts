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
export interface TaskRow extends ProjectRow {
  project_id: string;
  status: "pending" | "in-progress" | "done";
  version: number;
}
export function installProjects(
  app: Express,
  { db, now, authenticate, transaction }: JournalContext,
) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES members(id), created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0);`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, description TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES members(id), created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 1);`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS task_events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), diary_id TEXT NOT NULL, member_id TEXT NOT NULL REFERENCES members(id), before_status TEXT NOT NULL, after_status TEXT NOT NULL, created_at INTEGER NOT NULL);`,
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
  function task(id: string) {
    const row = db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(id) as unknown as TaskRow | undefined;
    if (!row) throw new HttpError(404, "未找到任务。");
    return row;
  }
  const taskView = (row: TaskRow) => ({
    ...view(row),
    projectId: row.project_id,
    status: row.status,
    version: row.version,
  });
  function createTask(
    projectId: string,
    input: z.infer<typeof definition>,
    memberId: string,
  ) {
    if (project(projectId).archived) throw new HttpError(409, "项目已归档。");
    const id = randomUUID();
    db.prepare(
      "INSERT INTO tasks (id, project_id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, projectId, input.name, input.description, memberId, now());
    return task(id);
  }
  app.get("/api/projects/:id/tasks", (req, res) => {
    authenticate(req);
    const p = project(z.uuid().parse(req.params.id));
    res.json(
      (
        db
          .prepare(
            "SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, id",
          )
          .all(p.id) as unknown as TaskRow[]
      ).map(taskView),
    );
  });
  app.post("/api/projects/:id/tasks", (req, res) => {
    const member = authenticate(req);
    res
      .status(201)
      .json(
        taskView(
          createTask(
            z.uuid().parse(req.params.id),
            definition.parse(req.body),
            member.id,
          ),
        ),
      );
  });
  app.get("/api/tasks/:id", (req, res) => {
    authenticate(req);
    res.json(taskView(task(z.uuid().parse(req.params.id))));
  });
  app.post("/api/tasks/:id/save", (req, res) => {
    const member = authenticate(req);
    const row = task(z.uuid().parse(req.params.id));
    if (row.created_by !== member.id)
      throw new HttpError(403, "只有创建者可修改任务定义。");
    const input = definition.parse(req.body);
    db.prepare("UPDATE tasks SET name = ?, description = ? WHERE id = ?").run(
      input.name,
      input.description,
      row.id,
    );
    res.json(taskView(task(row.id)));
  });
  app.get("/api/tasks/:id/progress", (req, res) => {
    authenticate(req);
    const row = task(z.uuid().parse(req.params.id));
    res.json(readPublished(db, dateRange(req.query), { taskId: row.id }));
  });
  app.get("/api/tasks/:id/events", (req, res) => {
    authenticate(req);
    const row = task(z.uuid().parse(req.params.id));
    res.json(
      db
        .prepare(
          "SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at, rowid",
        )
        .all(row.id)
        .map((e) => ({
          id: e.id,
          diaryId: e.diary_id,
          member: creator(String(e.member_id)),
          before: e.before_status,
          after: e.after_status,
          at: e.created_at,
        })),
    );
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
  app.post("/api/projects/:id/archive", (req, res) => {
    const member = authenticate(req),
      row = project(z.uuid().parse(req.params.id));
    if (row.created_by !== member.id)
      throw new HttpError(403, "只有创建者可以归档或恢复项目。");
    const input = z.object({ archived: z.boolean() }).parse(req.body);
    transaction(() => {
      db.prepare("UPDATE projects SET archived = ? WHERE id = ?").run(
        Number(input.archived),
        row.id,
      );
      if (input.archived)
        db.prepare(
          "UPDATE shares SET closed_at = COALESCE(closed_at, ?) WHERE (type = 'project' AND target_id = ?) OR (type = 'task' AND target_id IN (SELECT id FROM tasks WHERE project_id = ?))",
        ).run(now(), row.id, row.id);
    });
    res.json(view(project(row.id)));
  });
  app.post("/api/tasks/:id/archive", (req, res) => {
    const member = authenticate(req),
      row = task(z.uuid().parse(req.params.id));
    if (row.created_by !== member.id)
      throw new HttpError(403, "只有创建者可以归档或恢复任务。");
    const input = z.object({ archived: z.boolean() }).parse(req.body);
    transaction(() => {
      db.prepare("UPDATE tasks SET archived = ? WHERE id = ?").run(
        Number(input.archived),
        row.id,
      );
      if (input.archived)
        db.prepare(
          "UPDATE shares SET closed_at = COALESCE(closed_at, ?) WHERE type = 'task' AND target_id = ?",
        ).run(now(), row.id);
    });
    res.json(taskView(task(row.id)));
  });
  function prepareEntries(content: Content, memberId: string) {
    for (const entry of content.entries) {
      delete entry.projectName;
      delete entry.taskName;
      delete entry.taskStatus;
      if ((entry.taskId || entry.newTask) && !entry.projectId)
        throw new HttpError(400, "请先为任务选择项目。");
      if (entry.taskId && entry.newTask)
        throw new HttpError(400, "已有任务和新任务只能选择一个。");
      if (!entry.projectId) continue;
      const row = project(entry.projectId);
      if (row.archived)
        throw new HttpError(409, "项目已归档，请调整工作条目关联。");
      entry.projectName = row.name;
      if (entry.newTask) {
        entry.taskId = createTask(
          row.id,
          definition.parse(entry.newTask),
          memberId,
        ).id;
        delete entry.newTask;
      }
      if (entry.taskId) {
        const referenced = task(entry.taskId);
        if (referenced.project_id !== row.id)
          throw new HttpError(400, "任务必须属于当前条目的项目。");
        if (referenced.archived) throw new HttpError(409, "任务已归档。");
        entry.taskName = referenced.name;
        entry.taskStatus = referenced.status;
      }
    }
    return content;
  }
  function updateTaskStatuses(
    content: Content,
    memberId: string,
    diaryId: string,
  ) {
    const changes = new Map<
      string,
      NonNullable<Content["entries"][number]["statusChange"]>
    >();
    for (const entry of content.entries) {
      if (!entry.statusChange) continue;
      if (!entry.taskId) throw new HttpError(400, "状态更新必须关联任务。");
      const previous = changes.get(entry.taskId);
      if (
        previous &&
        JSON.stringify(previous) !== JSON.stringify(entry.statusChange)
      )
        throw new HttpError(400, "同一任务的状态选择不一致，请统一后再提交。");
      changes.set(entry.taskId, entry.statusChange);
    }
    const conflicts = [...changes].flatMap(([id, change]) => {
      const latest = task(id);
      return latest.version === change.expectedVersion
        ? []
        : [
            {
              taskId: id,
              taskName: latest.name,
              latestVersion: latest.version,
              latestStatus: latest.status,
              requestedStatus: change.status,
            },
          ];
    });
    if (conflicts.length)
      throw new HttpError(409, "任务状态已被更新，请选择如何处理后重新提交。", {
        conflicts,
      });
    for (const [id, change] of changes) {
      const before = task(id);
      if (change.resolution === "keep" || before.status === change.status)
        continue;
      db.prepare(
        "UPDATE tasks SET status = ?, version = version + 1 WHERE id = ?",
      ).run(change.status, id);
      db.prepare("INSERT INTO task_events VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        randomUUID(),
        id,
        diaryId,
        memberId,
        before.status,
        change.status,
        now(),
      );
    }
    for (const entry of content.entries) {
      if (entry.taskId) entry.taskStatus = task(entry.taskId).status;
      delete entry.statusChange;
    }
  }
  return { prepareEntries, updateTaskStatuses };
}
