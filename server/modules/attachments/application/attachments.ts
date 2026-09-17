import { assertAttachmentFile } from "../domain/attachment.ts";
import {
  attachFile,
  hasAttachment,
} from "../../journal/domain/attachment-references.ts";
import { DomainError } from "../../../shared/domain/errors.ts";
import type { AttachmentRepository, FileStorage } from "./ports.ts";
import type { DiaryRepository } from "../../journal/application/ports.ts";
import type { Runtime, Security } from "../../../shared/application/ports.ts";
import { ownedDiary } from "../../journal/application/journal.ts";
import type { Sharing } from "../../sharing/application/sharing.ts";

export class Attachments {
  constructor(
    private readonly repo: AttachmentRepository,
    private readonly diaries: DiaryRepository,
    private readonly sharing: Sharing,
    private readonly files: FileStorage,
    private readonly runtime: Runtime,
    private readonly security: Pick<Security, "digest">,
  ) {}
  upload(
    id: string,
    entryId: string,
    memberId: string,
    input: { version: number; requestId: string; name: string; base64: string },
    bytes: Uint8Array,
  ) {
    let written: string | undefined;
    try {
      return this.runtime.transaction(() => {
        const diary = ownedDiary(this.diaries, id, memberId),
          at = this.runtime.now();
        diary.assertWritable(at);
        assertAttachmentFile(input.name, bytes.length);
        const fingerprint = this.security.digest(
          `${id}:${entryId}:${input.name}:${input.base64}`,
        );
        const previous = this.repo.byRequest(memberId, input.requestId);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            throw new DomainError("conflict", "上传标识已使用。");
          return diary.view(at);
        }
        diary.assertVersion(input.version);
        const entry = diary.state.draft.entries.find((e) => e.id === entryId);
        if (!entry)
          throw new DomainError("not-found", "未找到工作条目，请先保存草稿。");
        const file = {
          id: this.runtime.id(),
          diaryId: id,
          entryId,
          memberId,
          name: input.name,
          size: bytes.length,
          requestId: input.requestId,
          fingerprint,
        };
        attachFile(entry, file);
        this.files.write(file.id, bytes);
        written = file.id;
        this.repo.add(file);
        diary.revise(diary.state.draft, input.version, at);
        this.diaries.save(diary.state);
        return diary.view(at);
      });
    } catch (error) {
      if (written) this.files.remove(written);
      throw error;
    }
  }
  cancel(id: string, memberId: string, requestId: string) {
    return this.runtime.transaction(() => {
      const diary = ownedDiary(this.diaries, id, memberId),
        at = this.runtime.now();
      diary.assertWritable(at);
      const uploaded = this.repo.byRequest(memberId, requestId);
      if (uploaded?.diaryId === id) {
        for (const entry of diary.state.draft.entries)
          if (entry.attachments)
            entry.attachments = entry.attachments.filter(
              (a) => a.id !== uploaded.id,
            );
        diary.revise(diary.state.draft, diary.state.version, at);
        this.diaries.save(diary.state);
      }
      return diary.view(at);
    });
  }
  private file(id: string) {
    const file = this.repo.find(id);
    if (!file) throw new DomainError("not-found", "未找到附件。");
    return file;
  }
  read(id: string, memberId: string) {
    const file = this.file(id),
      diary = this.diaries.find(file.diaryId);
    if (
      !diary ||
      (!(diary.authorId === memberId && hasAttachment(diary.draft, id)) &&
        !(diary.published && hasAttachment(diary.published, id)))
    )
      throw new DomainError("not-found", "未找到附件。");
    return { name: file.name, bytes: this.files.read(id) };
  }
  readPublic(token: string, id: string) {
    const share = this.sharing.available(token);
    if (
      !share.allows("progress") ||
      !this.sharing.progress(share).some((r) => hasAttachment(r.published, id))
    )
      throw new DomainError("not-found", "未找到附件。");
    return { name: this.file(id).name, bytes: this.files.read(id) };
  }
}
