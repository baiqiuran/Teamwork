import { Module, type DynamicModule } from "@nestjs/common";
import { Work } from "../modules/work/application/work.ts";
import { Reading } from "../modules/journal/application/reading.ts";
import { WorkController } from "../modules/work/interfaces/http/work.controller.ts";
import type { Resources } from "./resources.ts";
import { WORK, SHARES, RUNTIME } from "./tokens.ts";

@Module({})
class WorkModule {}

export function workModule(
  infrastructure: DynamicModule,
  reading: DynamicModule,
): DynamicModule {
  return {
    module: WorkModule,
    exports: [Work],
    controllers: [WorkController],
    imports: [infrastructure, reading],
    providers: [
      {
        provide: Work,
        inject: [WORK, SHARES, Reading, RUNTIME],
        useFactory: (
          repo: Resources["work"],
          shares: Resources["shares"],
          read: Reading,
          runtime: Resources["runtime"],
        ) => new Work(repo, shares, read, runtime),
      },
    ],
  };
}
