import type { DatabaseSync } from "node:sqlite";
import type { AttachmentRepository } from "../../application/ports.ts";
import type { Attachment } from "../../domain/attachment.ts";
const select =
  "SELECT id, diary_id AS diaryId, entry_id AS entryId, member_id AS memberId, name, size, request_id AS requestId, fingerprint FROM attachments";
export function attachmentRepository(db: DatabaseSync): AttachmentRepository {
  return {
    find: (id) =>
      db.prepare(`${select} WHERE id = ?`).get(id) as unknown as
        Attachment | undefined,
    byRequest: (memberId, requestId) =>
      db
        .prepare(`${select} WHERE member_id = ? AND request_id = ?`)
        .get(memberId, requestId) as unknown as Attachment | undefined,
    add: (f) => {
      db.prepare("INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        f.id,
        f.diaryId,
        f.entryId,
        f.memberId,
        f.name,
        f.size,
        f.requestId,
        f.fingerprint,
      );
    },
  };
}
