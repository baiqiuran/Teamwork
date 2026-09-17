import { DomainError } from "../../../shared/domain/errors.ts";
import type { Content, WorkEntry } from "./diary.ts";
import type { Attachment } from "../../attachments/domain/attachment.ts";
export const hasAttachment = (content: Content, id: string) =>
  content.entries.some((entry) =>
    entry.attachments?.some((ref) => ref.id === id),
  );
export function attachFile(entry: WorkEntry, file: Attachment) {
  if ((entry.attachments?.length ?? 0) >= 10)
    throw new DomainError("invalid", "每条工作最多 10 个附件。");
  entry.attachments = [
    ...(entry.attachments ?? []),
    { id: file.id, name: file.name, size: file.size },
  ];
}
