import { Module, type DynamicModule } from "@nestjs/common";
import { Journal } from "../modules/journal/application/journal.ts";
import { Work } from "../modules/work/application/work.ts";
import { Sharing } from "../modules/sharing/application/sharing.ts";
import { Reading } from "../modules/journal/application/reading.ts";
import type { Resources } from "./resources.ts";
import { AiAuthorization } from "../modules/ai/application/ai-authorization.ts";
import { AiReading } from "../modules/ai/application/ai-reading.ts";
import { AiJournal } from "../modules/ai/application/ai-journal.ts";
import { AiOperations } from "../modules/ai/application/ai-operations.ts";
import { AiWork } from "../modules/ai/application/ai-work.ts";
import { AiSharing } from "../modules/ai/application/ai-sharing.ts";
import { AiHistory } from "../modules/ai/application/ai-history.ts";
import { McpLimits } from "../modules/ai/interfaces/http/mcp-limits.ts";
import { AiController } from "../modules/ai/interfaces/http/ai.controller.ts";
import { SiteAddress } from "../interfaces/http/site-address.ts";
import { MEMBERS, RUNTIME, SECURITY, AI, AI_OPERATIONS } from "./tokens.ts";

@Module({})
class AiModule {}

export function aiModule(
  resources: Resources,
  infrastructure: DynamicModule,
  reading: DynamicModule,
  work: DynamicModule,
  journal: DynamicModule,
  sharing: DynamicModule,
): DynamicModule {
  return {
    module: AiModule,
    imports: [infrastructure, reading, work, journal, sharing],
    controllers: [AiController],
    providers: [
      { provide: SiteAddress, useValue: new SiteAddress(resources.publicUrl) },
      {
        provide: McpLimits,
        useValue: new McpLimits(
          resources.mcpMemberLimit,
          resources.mcpGrantLimit,
        ),
      },
      {
        provide: AiSharing,
        inject: [Sharing, AiOperations, AiAuthorization, AiReading],
        useFactory: (
          sharing: Sharing,
          operations: AiOperations,
          auth: AiAuthorization,
          read: AiReading,
        ) => new AiSharing(sharing, operations, auth, read),
      },
      {
        provide: AiWork,
        inject: [Work, AiOperations],
        useFactory: (work: Work, operations: AiOperations) =>
          new AiWork(work, operations),
      },
      {
        provide: AiOperations,
        inject: [AiAuthorization, AI_OPERATIONS, RUNTIME, SECURITY],
        useFactory: (
          auth: AiAuthorization,
          repo: Resources["aiOperations"],
          runtime: Resources["runtime"],
          security: Resources["security"],
        ) => new AiOperations(auth, repo, runtime, security),
      },
      {
        provide: AiHistory,
        inject: [AI_OPERATIONS, AiReading, Journal, Work, Sharing],
        useFactory: (
          repo: Resources["aiOperations"],
          read: AiReading,
          journal: Journal,
          work: Work,
          sharing: Sharing,
        ) => new AiHistory(repo, read, journal, work, sharing),
      },
      {
        provide: AiJournal,
        inject: [Journal, Work, AiOperations, AiAuthorization, AiReading],
        useFactory: (
          journal: Journal,
          work: Work,
          operations: AiOperations,
          auth: AiAuthorization,
          read: AiReading,
        ) => new AiJournal(journal, work, operations, auth, read),
      },
      {
        provide: AiReading,
        inject: [Reading, Work, RUNTIME, SECURITY],
        useFactory: (
          read: Reading,
          work: Work,
          runtime: Resources["runtime"],
          security: Resources["security"],
        ) => new AiReading(read, work, runtime, security),
      },
      {
        provide: AiAuthorization,
        inject: [AI, MEMBERS, RUNTIME, SECURITY],
        useFactory: (
          repo: Resources["ai"],
          members: Resources["members"],
          runtime: Resources["runtime"],
          security: Resources["security"],
        ) => new AiAuthorization(repo, members, runtime, security),
      },
    ],
  };
}
