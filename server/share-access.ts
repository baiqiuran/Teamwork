import type { DatabaseSync } from "node:sqlite";
import { HttpError } from "./http-error.ts";
import { readPublished } from "./published.ts";
export interface ShareRow {
  id: string;
  token: string;
  created_by: string;
  type: "diary" | "project" | "task";
  target_id: string | null;
  modules: string;
  from_date: string;
  to_date: string;
  created_at: number;
  closed_at: number | null;
}
export function availableShare(db: DatabaseSync, token: string): ShareRow {
  const row = db
    .prepare("SELECT * FROM shares WHERE token = ?")
    .get(token) as unknown as ShareRow | undefined;
  if (!row || row.closed_at !== null)
    throw new HttpError(410, "此公开链接无效或已关闭。");
  return row;
}
export function readShareProgress(db: DatabaseSync, row: ShareRow) {
  return readPublished(
    db,
    { from: row.from_date, to: row.to_date },
    {
      projectId: row.type === "project" ? row.target_id! : undefined,
      taskId: row.type === "task" ? row.target_id! : undefined,
    },
  );
}
