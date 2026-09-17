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
import { aiAuthorizationRepository } from "../infrastructure/sqlite/ai-authorization-repository.ts";
import { aiOperationRepository } from "../infrastructure/sqlite/ai-operation-repository.ts";

export interface AppOptions {
  databasePath: string;
  setupKey: string;
  now?: () => number;
  staticDirectory?: string;
  publicUrl?: string;
  codexRedirectUris?: string[];
  mcpMemberLimit?: number;
  mcpGrantLimit?: number;
  mcpMaxBodyBytes?: number;
}

/** One owner per application, including when container initialization fails. */
export function createResources(options: AppOptions) {
  const redirects = options.codexRedirectUris ?? ["http://127.0.0.1/callback"];
  if (!redirects.length) throw new Error("至少登记一个 Codex 回调地址。");
  for (const value of redirects) {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      url.pathname.includes("*")
    )
      throw new Error("Codex 回调须为明确的本机 HTTP 地址，不允许通配符。");
  }
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
      ai: aiAuthorizationRepository(database.db, redirects),
      aiOperations: aiOperationRepository(database.db),
      publicUrl: options.publicUrl,
      mcpMemberLimit: options.mcpMemberLimit,
      mcpGrantLimit: options.mcpGrantLimit,
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
