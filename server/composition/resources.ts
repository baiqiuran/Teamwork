import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { openDatabase } from "../infrastructure/sqlite/database.ts";
import { attachmentRepository } from "../modules/attachments/infrastructure/sqlite/attachment-repository.ts";
import { diaryRepository } from "../modules/journal/infrastructure/sqlite/diary-repository.ts";
import { membershipRepository } from "../modules/membership/infrastructure/sqlite/membership-repository.ts";
import { sharingRepository } from "../modules/sharing/infrastructure/sqlite/sharing-repository.ts";
import { workRepository } from "../modules/work/infrastructure/sqlite/work-repository.ts";
import { localFiles } from "../modules/attachments/infrastructure/files.ts";
import * as security from "../infrastructure/security.ts";
import { aiAuthorizationRepository } from "../modules/ai/infrastructure/sqlite/ai-authorization-repository.ts";
import { aiOperationRepository } from "../modules/ai/infrastructure/sqlite/ai-operation-repository.ts";
import type { Runtime, Security } from "../shared/application/ports.ts";
import type { MembershipRepository } from "../modules/membership/application/ports.ts";
import type { DiaryRepository } from "../modules/journal/application/ports.ts";
import type { WorkRepository } from "../modules/work/application/ports.ts";
import type { SharingRepository } from "../modules/sharing/application/ports.ts";
import type {
  AttachmentRepository,
  FileStorage,
} from "../modules/attachments/application/ports.ts";
import type {
  AiAuthorizationRepository,
  AiOperationRepository,
} from "../modules/ai/application/ports.ts";

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
  releaseCommit?: string;
  healthToken?: string;
}

/** The composition root exposes ports, never concrete adapter return types. */
export interface Resources {
  members: MembershipRepository;
  diaries: DiaryRepository;
  work: WorkRepository;
  shares: SharingRepository;
  attachments: AttachmentRepository;
  ai: AiAuthorizationRepository;
  aiOperations: AiOperationRepository;
  runtime: Runtime;
  security: Security;
  files: FileStorage;
  setupKey: string;
  publicUrl?: string;
  mcpMemberLimit?: number;
  mcpGrantLimit?: number;
  close(): void;
  inspect(deep: boolean): { schema?: number; integrity?: string };
}

/** One owner per application, including when container initialization fails. */
export function createResources(options: AppOptions): Resources {
  const configuredRedirects = options.codexRedirectUris ?? [
    "http://127.0.0.1/callback",
  ];
  if (!configuredRedirects.length)
    throw new Error("至少登记一个 Codex 回调地址。");
  // Codex binds its callback path to the complete MCP URL with the first nine SHA-256 bytes.
  const codexCallback = options.publicUrl
    ? `http://127.0.0.1/callback/${createHash("sha256")
        .update(new URL("/mcp", options.publicUrl).href)
        .digest()
        .subarray(0, 9)
        .toString("base64url")}`
    : undefined;
  const redirects = [
    ...new Set([
      ...configuredRedirects,
      ...(codexCallback ? [codexCallback] : []),
    ]),
  ];
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
      inspect: database.inspect,
    };
  } catch (error) {
    close();
    throw error;
  }
}
