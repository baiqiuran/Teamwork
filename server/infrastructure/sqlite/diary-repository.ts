import type { DatabaseSync } from "node:sqlite";
import type {
  DiaryDeletion,
  DiaryRepository,
  SubmissionReceipt,
} from "../../application/ports.ts";
import type { DiaryState } from "../../domain/diary.ts";

interface DiaryRow extends Omit<DiaryState, "draft" | "published"> {
  draft: string;
  published: string | null;
}
const select = `SELECT id, author_id AS authorId, draft, version, created_at AS createdAt, updated_at AS updatedAt, published, first_at AS firstSubmittedAt, submitted_at AS submittedAt, diary_date AS diaryDate FROM diaries`;
const hydrate = (row: DiaryRow): DiaryState => ({
  ...row,
  draft: JSON.parse(row.draft),
  published: row.published ? JSON.parse(row.published) : null,
});
export function diaryRepository(db: DatabaseSync): DiaryRepository {
  const deletionSelect = `SELECT diary_id AS diaryId, member_id AS memberId, action, created_at AS at FROM diary_events`;
  return {
    find(id) {
      const row = db.prepare(`${select} WHERE id = ?`).get(id) as unknown as
        DiaryRow | undefined;
      return row && hydrate(row);
    },
    mine: (id) =>
      (
        db
          .prepare(
            `${select} WHERE author_id = ? ORDER BY updated_at DESC, rowid DESC`,
          )
          .all(id) as unknown as DiaryRow[]
      ).map(hydrate),
    published: (range) =>
      (
        db
          .prepare(
            `${select} WHERE published IS NOT NULL AND diary_date BETWEEN ? AND ? ORDER BY diary_date DESC, submitted_at DESC, id`,
          )
          .all(range.from, range.to) as unknown as DiaryRow[]
      ).map(hydrate),
    save(s) {
      db.prepare(
        `INSERT INTO diaries (id, author_id, draft, version, created_at, updated_at, published, first_at, submitted_at, diary_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET draft = excluded.draft, version = excluded.version, updated_at = excluded.updated_at, published = excluded.published, first_at = excluded.first_at, submitted_at = excluded.submitted_at, diary_date = excluded.diary_date`,
      ).run(
        s.id,
        s.authorId,
        JSON.stringify(s.draft),
        s.version,
        s.createdAt,
        s.updatedAt,
        s.published ? JSON.stringify(s.published) : null,
        s.firstSubmittedAt,
        s.submittedAt,
        s.diaryDate,
      );
    },
    remove: (id) => {
      db.prepare("DELETE FROM diaries WHERE id = ?").run(id);
    },
    deletion: (id, memberId) =>
      db
        .prepare(`${deletionSelect} WHERE diary_id = ? AND member_id = ?`)
        .get(id, memberId) as unknown as DiaryDeletion | undefined,
    deletions: () =>
      db
        .prepare(`${deletionSelect} ORDER BY created_at DESC`)
        .all() as unknown as DiaryDeletion[],
    addDeletion: (e) => {
      db.prepare("INSERT INTO diary_events VALUES (?, ?, ?, ?)").run(
        e.diaryId,
        e.memberId,
        e.action,
        e.at,
      );
    },
    receipt(memberId, requestId) {
      const row = db
        .prepare(
          "SELECT member_id AS memberId, request_id AS requestId, diary_id AS diaryId, input_version AS inputVersion, result FROM submission_receipts WHERE member_id = ? AND request_id = ?",
        )
        .get(memberId, requestId) as unknown as
        (Omit<SubmissionReceipt, "result"> & { result: string }) | undefined;
      return row && { ...row, result: JSON.parse(row.result) };
    },
    addReceipt: (r) => {
      db.prepare("INSERT INTO submission_receipts VALUES (?, ?, ?, ?, ?)").run(
        r.memberId,
        r.requestId,
        r.diaryId,
        r.inputVersion,
        JSON.stringify(r.result),
      );
    },
  };
}
