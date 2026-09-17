import { assertAttachmentOwner } from "../../attachments/domain/attachment.ts";
import type { Content } from "../domain/diary.ts";
import { DomainError } from "../../../shared/domain/errors.ts";
import type { AttachmentRepository } from "../../attachments/application/ports.ts";

export function normalizeAttachments(
  repo: AttachmentRepository,
  content: Content,
  diaryId: string,
  memberId: string,
) {
  for (const entry of content.entries) {
    const ids = new Set<string>();
    if (!entry.attachments) continue;
    entry.attachments = entry.attachments.map((ref) => {
      const file = repo.find(ref.id);
      if (!file) throw new DomainError("not-found", "未找到附件。");
      assertAttachmentOwner(file, diaryId, entry.id, memberId);
      if (ids.has(file.id))
        throw new DomainError("invalid", "不能重复添加同一附件。");
      ids.add(file.id);
      return { id: file.id, name: file.name, size: file.size };
    });
  }
}
