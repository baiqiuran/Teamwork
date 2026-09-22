import type { DatabaseSync } from "node:sqlite";
import type { TaskEvent } from "../../domain/task-event.ts";
import type { WorkRepository } from "../../application/ports.ts";
import type { ProjectState, TaskState } from "../../domain/work.ts";
const fields = `id, name, description, created_by AS createdBy, created_at AS createdAt, archived`;
type Stored<T> = Omit<T, "archived"> & { archived: number };
const project = (s: Stored<ProjectState>): ProjectState => ({
  ...s,
  archived: !!s.archived,
});
const task = (s: Stored<TaskState>): TaskState => ({
  ...s,
  archived: !!s.archived,
});
const tasks = `SELECT ${fields}, project_id AS projectId, status, version FROM tasks`;
const teamMembers = `SELECT id FROM members WHERE team_id = (SELECT team_id FROM members WHERE id = ?)`;
const taskScope = `created_by IN (${teamMembers}) AND project_id IN (
  SELECT p.id FROM projects p
  JOIN members creator ON creator.id = p.created_by
  JOIN members owner ON owner.id = tasks.created_by
  WHERE creator.team_id = owner.team_id
)`;
export function workRepository(db: DatabaseSync): WorkRepository {
  return {
    project(id, memberId) {
      const row = db
        .prepare(
          `SELECT ${fields} FROM projects WHERE id = ? AND created_by IN (${teamMembers})`,
        )
        .get(id, memberId) as unknown as Stored<ProjectState> | undefined;
      return row && project(row);
    },
    projects: (memberId) =>
      (
        db
          .prepare(
            `SELECT ${fields} FROM projects WHERE created_by IN (${teamMembers}) ORDER BY created_at DESC, id`,
          )
          .all(memberId) as unknown as Stored<ProjectState>[]
      ).map(project),
    saveProject: (s) => {
      db.prepare(
        `INSERT INTO projects (id, name, description, created_by, created_at, archived) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, archived = excluded.archived`,
      ).run(
        s.id,
        s.name,
        s.description,
        s.createdBy,
        s.createdAt,
        Number(s.archived),
      );
    },
    task(id, memberId) {
      const row = db
        .prepare(`${tasks} WHERE id = ? AND ${taskScope}`)
        .get(id, memberId) as unknown as Stored<TaskState> | undefined;
      return row && task(row);
    },
    tasks: (memberId, id) =>
      (id
        ? db
            .prepare(
              `${tasks} WHERE project_id = ? AND ${taskScope} ORDER BY created_at, id`,
            )
            .all(id, memberId)
        : db
            .prepare(`${tasks} WHERE ${taskScope} ORDER BY created_at, id`)
            .all(memberId)
      ).map((row) => task(row as unknown as Stored<TaskState>)),
    saveTask: (s) => {
      db.prepare(
        `INSERT INTO tasks (id, project_id, name, description, created_by, created_at, archived, status, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, archived = excluded.archived, status = excluded.status, version = excluded.version`,
      ).run(
        s.id,
        s.projectId,
        s.name,
        s.description,
        s.createdBy,
        s.createdAt,
        Number(s.archived),
        s.status,
        s.version,
      );
    },
    addEvent: (e) => {
      db.prepare(
        "INSERT INTO task_events (id,task_id,diary_id,member_id,before_status,after_status,created_at,kind,channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        e.id,
        e.taskId,
        e.diaryId,
        e.memberId,
        e.before,
        e.after,
        e.at,
        e.kind,
        e.channel,
      );
    },
    events: (id, memberId) =>
      db
        .prepare(
          `SELECT id, task_id AS taskId, diary_id AS diaryId, member_id AS memberId, before_status AS before, after_status AS after, created_at AS at, kind, channel FROM task_events WHERE task_id = ? AND task_id IN (SELECT id FROM tasks WHERE ${taskScope}) AND member_id IN (${teamMembers}) AND (diary_id IS NULL OR diary_id IN (SELECT id FROM diaries WHERE author_id IN (${teamMembers})) OR diary_id IN (SELECT diary_id FROM diary_events WHERE member_id IN (${teamMembers}))) ORDER BY created_at, rowid`,
        )
        .all(
          id,
          memberId,
          memberId,
          memberId,
          memberId,
        ) as unknown as TaskEvent[],
  };
}
