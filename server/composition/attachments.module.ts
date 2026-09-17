import { Module, type DynamicModule } from "@nestjs/common";
import { Sharing } from "../modules/sharing/application/sharing.ts";
import { Attachments } from "../modules/attachments/application/attachments.ts";
import { AttachmentsController } from "../modules/attachments/interfaces/http/attachments.controller.ts";
import type { Resources } from "./resources.ts";
import { DIARIES, ATTACHMENTS, RUNTIME, SECURITY, FILES } from "./tokens.ts";

@Module({})
class AttachmentsModule {}

export function attachmentsModule(
  infrastructure: DynamicModule,
  sharing: DynamicModule,
): DynamicModule {
  return {
    module: AttachmentsModule,
    controllers: [AttachmentsController],
    imports: [infrastructure, sharing],
    providers: [
      {
        provide: Attachments,
        inject: [ATTACHMENTS, DIARIES, Sharing, FILES, RUNTIME, SECURITY],
        useFactory: (
          repo: Resources["attachments"],
          diaries: Resources["diaries"],
          share: Sharing,
          files: Resources["files"],
          runtime: Resources["runtime"],
          security: Resources["security"],
        ) => new Attachments(repo, diaries, share, files, runtime, security),
      },
    ],
  };
}
