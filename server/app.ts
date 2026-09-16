import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { Attachments } from "./application/attachments.ts";
import { Journal } from "./application/journal.ts";
import { Membership } from "./application/membership.ts";
import { Reading } from "./application/reading.ts";
import { Sharing } from "./application/sharing.ts";
import { Work } from "./application/work.ts";
import { openDatabase } from "./infrastructure/sqlite/database.ts";
import { attachmentRepository } from "./infrastructure/sqlite/attachment-repository.ts";
import { diaryRepository } from "./infrastructure/sqlite/diary-repository.ts";
import { membershipRepository } from "./infrastructure/sqlite/membership-repository.ts";
import { sharingRepository } from "./infrastructure/sqlite/sharing-repository.ts";
import { workRepository } from "./infrastructure/sqlite/work-repository.ts";
import { localFiles } from "./infrastructure/files.ts";
import * as security from "./infrastructure/security.ts";
import { createHttpApp } from "./interfaces/http/http-app.ts";

export interface AppOptions {
  databasePath: string;
  setupKey: string;
  now?: () => number;
}

/** Composition root: concrete adapters are selected only here. */
export function createApp(options: AppOptions) {
  const database = openDatabase(options.databasePath);
  try {
    const runtime = {
      now: options.now ?? Date.now,
      id: randomUUID,
      transaction: database.transaction,
    };
    const members = membershipRepository(database.db),
      diaries = diaryRepository(database.db);
    const workRepo = workRepository(database.db),
      shares = sharingRepository(database.db),
      files = attachmentRepository(database.db);
    const reading = new Reading(diaries, members);
    const membership = new Membership(
      members,
      runtime,
      security,
      options.setupKey,
    );
    const sharing = new Sharing(shares, workRepo, reading, runtime, security);
    const work = new Work(workRepo, shares, reading, runtime);
    const journal = new Journal(diaries, workRepo, files, reading, runtime);
    const attachments = new Attachments(
      files,
      diaries,
      sharing,
      localFiles(resolve(dirname(options.databasePath), "attachments")),
      runtime,
      security,
    );
    const app = createHttpApp({
      membership,
      journal,
      work,
      sharing,
      attachments,
      reading,
    });
    return { app, close: database.close };
  } catch (error) {
    database.close();
    throw error;
  }
}
