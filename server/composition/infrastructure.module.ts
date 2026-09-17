import { Module, type DynamicModule } from "@nestjs/common";
import type { Resources } from "./resources.ts";
import {
  MEMBERS,
  DIARIES,
  WORK,
  SHARES,
  ATTACHMENTS,
  RUNTIME,
  SECURITY,
  FILES,
  SETUP_KEY,
  AI,
  AI_OPERATIONS,
} from "./tokens.ts";

@Module({})
class InfrastructureModule {}

export function infrastructureModule(resources: Resources): DynamicModule {
  return {
    module: InfrastructureModule,
    providers: [
      { provide: AI, useValue: resources.ai },
      { provide: AI_OPERATIONS, useValue: resources.aiOperations },
      { provide: MEMBERS, useValue: resources.members },
      { provide: DIARIES, useValue: resources.diaries },
      { provide: WORK, useValue: resources.work },
      { provide: SHARES, useValue: resources.shares },
      { provide: ATTACHMENTS, useValue: resources.attachments },
      { provide: RUNTIME, useValue: resources.runtime },
      { provide: SECURITY, useValue: resources.security },
      { provide: FILES, useValue: resources.files },
      { provide: SETUP_KEY, useValue: resources.setupKey },
    ],
    exports: [
      AI,
      AI_OPERATIONS,
      MEMBERS,
      DIARIES,
      WORK,
      SHARES,
      ATTACHMENTS,
      RUNTIME,
      SECURITY,
      FILES,
      SETUP_KEY,
    ],
  };
}
