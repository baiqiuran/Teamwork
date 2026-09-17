import type { Attachment } from "../domain/attachment.ts";

export interface AttachmentRepository {
  find(id: string): Attachment | undefined;
  byRequest(memberId: string, requestId: string): Attachment | undefined;
  add(file: Attachment): void;
}

export interface FileStorage {
  write(id: string, bytes: Uint8Array): void;
  remove(id: string): void;
  read(id: string): Uint8Array;
}
