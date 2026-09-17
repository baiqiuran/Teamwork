import { Module, type DynamicModule } from "@nestjs/common";
import { Journal } from "../modules/journal/application/journal.ts";
import { Reading } from "../modules/journal/application/reading.ts";
import { JournalController } from "../modules/journal/interfaces/http/journal.controller.ts";
import type { Resources } from "./resources.ts";
import { DIARIES, WORK, ATTACHMENTS, RUNTIME } from "./tokens.ts";

@Module({})
class JournalModule {}

export function journalModule(
  infrastructure: DynamicModule,
  reading: DynamicModule,
): DynamicModule {
  return {
    module: JournalModule,
    exports: [Journal],
    controllers: [JournalController],
    imports: [infrastructure, reading],
    providers: [
      {
        provide: Journal,
        inject: [DIARIES, WORK, ATTACHMENTS, Reading, RUNTIME],
        useFactory: (
          diaries: Resources["diaries"],
          tasks: Resources["work"],
          files: Resources["attachments"],
          read: Reading,
          runtime: Resources["runtime"],
        ) => new Journal(diaries, tasks, files, read, runtime),
      },
    ],
  };
}
