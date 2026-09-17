import { DomainError } from "../../../shared/domain/errors.ts";
export interface Attachment {
  id: string;
  diaryId: string;
  entryId: string;
  memberId: string;
  name: string;
  size: number;
  requestId: string;
  fingerprint: string;
}
export function assertAttachmentFile(name: string, size: number) {
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  if (
    ![
      ".png",
      ".jpg",
      ".jpeg",
      ".webp",
      ".pdf",
      ".txt",
      ".csv",
      ".docx",
      ".xlsx",
      ".pptx",
    ].includes(extension)
  )
    throw new DomainError("invalid", "不支持此文件类型。");
  if (!size || size > 20 * 1024 * 1024)
    throw new DomainError("invalid", "单个文件须为 1 字节至 20 MB。");
}
export function assertAttachmentOwner(
  file: Attachment,
  diaryId: string,
  entryId: string,
  memberId: string,
) {
  if (
    file.diaryId !== diaryId ||
    file.entryId !== entryId ||
    file.memberId !== memberId
  )
    throw new DomainError("not-found", "未找到附件。");
}
