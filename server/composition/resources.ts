import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { openDatabase } from "../infrastructure/sqlite/database.ts";
import { attachmentRepository } from "../infrastructure/sqlite/attachment-repository.ts";
import { diaryRepository } from "../infrastructure/sqlite/diary-repository.ts";
import { membershipRepository } from "../infrastructure/sqlite/membership-repository.ts";
import { sharingRepository } from "../infrastructure/sqlite/sharing-repository.ts";
import { workRepository } from "../infrastructure/sqlite/work-repository.ts";
import { localFiles } from "../infrastructure/files.ts";
import * as security from "../infrastructure/security.ts";

export interface AppOptions {
  databasePath: string;
  setupKey: string;
  now?: () => number;
  staticDirectory?: string;
}

/** One owner per application, including when container initialization fails. */
export function createResources(options: AppOptions) {
  const database = openDatabase(options.databasePath);
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      database.close();
    }
  };
  try {
    return {
      members: membershipRepository(database.db),
      diaries: diaryRepository(database.db),
      work: workRepository(database.db),
      shares: sharingRepository(database.db),
      attachments: attachmentRepository(database.db),
      runtime: {
        now: options.now ?? Date.now,
        id: randomUUID,
        transaction: database.transaction,
      },
      security,
      files: localFiles(resolve(dirname(options.databasePath), "attachments")),
      setupKey: options.setupKey,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
export type Resources = ReturnType<typeof createResources>;
