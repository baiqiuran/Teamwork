import { Module, type DynamicModule } from "@nestjs/common";
import { Sharing } from "../modules/sharing/application/sharing.ts";
import { Reading } from "../modules/journal/application/reading.ts";
import { SharingController } from "../modules/sharing/interfaces/http/sharing.controller.ts";
import type { Resources } from "./resources.ts";
import { WORK, SHARES, RUNTIME, SECURITY } from "./tokens.ts";

@Module({})
class SharingModule {}

export function sharingModule(
  infrastructure: DynamicModule,
  reading: DynamicModule,
): DynamicModule {
  return {
    module: SharingModule,
    controllers: [SharingController],
    imports: [infrastructure, reading],
    providers: [
      {
        provide: Sharing,
        inject: [SHARES, WORK, Reading, RUNTIME, SECURITY],
        useFactory: (
          shares: Resources["shares"],
          tasks: Resources["work"],
          read: Reading,
          runtime: Resources["runtime"],
          security: Resources["security"],
        ) => new Sharing(shares, tasks, read, runtime, security),
      },
    ],
    exports: [Sharing],
  };
}
