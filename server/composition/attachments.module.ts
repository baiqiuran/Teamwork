import { Module, type DynamicModule } from "@nestjs/common";
import { Sharing } from "../modules/sharing/application/sharing.ts";
import { Reading } from "../modules/journal/application/reading.ts";
import { Attachments } from "../modules/attachments/application/attachments.ts";
import { AttachmentsController } from "../modules/attachments/interfaces/http/attachments.controller.ts";
import type { Resources } from "./resources.ts";
import { DIARIES, ATTACHMENTS, RUNTIME, SECURITY, FILES } from "./tokens.ts";

@Module({})
class AttachmentsModule {}

export function attachmentsModule(
  infrastructure: DynamicModule,
  sharing: DynamicModule,
  reading: DynamicModule,
): DynamicModule {
  return {
    module: AttachmentsModule,
    controllers: [AttachmentsController],
    imports: [infrastructure, sharing, reading],
    providers: [
      {
        provide: Attachments,
        inject: [
          ATTACHMENTS,
          DIARIES,
          Sharing,
          FILES,
          RUNTIME,
          SECURITY,
          Reading,
        ],
        useFactory: (
          repo: Resources["attachments"],
          diaries: Resources["diaries"],
          share: Sharing,
          files: Resources["files"],
          runtime: Resources["runtime"],
          security: Resources["security"],
          read: Reading,
        ) =>
          new Attachments(repo, diaries, share, files, runtime, security, read),
      },
    ],
  };
}
