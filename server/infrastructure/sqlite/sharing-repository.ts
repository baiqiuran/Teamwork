import type { DatabaseSync } from "node:sqlite";
import type { SharingRepository } from "../../application/ports.ts";
import type { ShareState } from "../../domain/sharing.ts";
const select = `SELECT id, token, created_by AS createdBy, type, target_id AS targetId, modules, from_date AS "from", to_date AS "to", created_at AS createdAt, closed_at AS closedAt FROM shares`;
type Row = Omit<ShareState, "modules"> & { modules: string };
const hydrate = (row: Row): ShareState => ({
  ...row,
  modules: JSON.parse(row.modules),
});
export function sharingRepository(db: DatabaseSync): SharingRepository {
  return {
    find(id) {
      const row = db.prepare(`${select} WHERE id = ?`).get(id) as unknown as
        Row | undefined;
      return row && hydrate(row);
    },
    byToken(token) {
      const row = db
        .prepare(`${select} WHERE token = ?`)
        .get(token) as unknown as Row | undefined;
      return row && hydrate(row);
    },
    mine: (id) =>
      (
        db
          .prepare(
            `${select} WHERE created_by = ? ORDER BY created_at DESC, rowid DESC`,
          )
          .all(id) as unknown as Row[]
      ).map(hydrate),
    save: (s) => {
      db.prepare(
        `INSERT INTO shares (id, token, created_by, type, target_id, modules, from_date, to_date, created_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET closed_at = excluded.closed_at`,
      ).run(
        s.id,
        s.token,
        s.createdBy,
        s.type,
        s.targetId,
        JSON.stringify(s.modules),
        s.from,
        s.to,
        s.createdAt,
        s.closedAt,
      );
    },
    closeForProject: (id, at) => {
      db.prepare(
        "UPDATE shares SET closed_at = COALESCE(closed_at, ?) WHERE (type = 'project' AND target_id = ?) OR (type = 'task' AND target_id IN (SELECT id FROM tasks WHERE project_id = ?))",
      ).run(at, id, id);
    },
    closeForTask: (id, at) => {
      db.prepare(
        "UPDATE shares SET closed_at = COALESCE(closed_at, ?) WHERE type = 'task' AND target_id = ?",
      ).run(at, id);
    },
  };
}
