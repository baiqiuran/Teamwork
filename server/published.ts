import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Content, DiaryRow } from "./journal.ts";
import { HttpError } from "./http-error.ts";
export function dateRange(query: Record<string, unknown>) {
  const from = query.from ? z.iso.date().parse(query.from) : "0001-01-01";
  const to = query.to ? z.iso.date().parse(query.to) : "9999-12-31";
  if (from > to) throw new HttpError(400, "开始日期不能晚于结束日期。");
  return { from, to };
}
export function readPublished(
  db: DatabaseSync,
  range: { from: string; to: string },
  filter: {
    projectId?: string;
    taskId?: string;
    memberId?: string;
    complete?: boolean;
  } = {},
) {
  const rows = db
    .prepare(
      "SELECT * FROM diaries WHERE published IS NOT NULL AND diary_date BETWEEN ? AND ? ORDER BY diary_date DESC, submitted_at DESC, id",
    )
    .all(range.from, range.to) as unknown as DiaryRow[];
  return rows
    .filter((row) => !filter.memberId || row.author_id === filter.memberId)
    .flatMap((row) => {
      const content = JSON.parse(row.published!) as Content;
      const entries = content.entries.filter(
        (e) =>
          (!filter.projectId || e.projectId === filter.projectId) &&
          (!filter.taskId || e.taskId === filter.taskId),
      );
      if (!entries.length) return [];
      return [
        {
          id: row.id,
          author: db
            .prepare("SELECT id, name FROM members WHERE id = ?")
            .get(row.author_id),
          diaryDate: row.diary_date,
          submittedAt: row.submitted_at,
          firstSubmittedAt: row.first_at,
          published: {
            ...content,
            title:
              (filter.projectId || filter.taskId) && !filter.complete
                ? ""
                : content.title,
            entries: filter.complete ? content.entries : entries,
          },
        },
      ];
    });
}
