import { Module, type DynamicModule } from "@nestjs/common";
import { Reading } from "../modules/journal/application/reading.ts";
import type { Resources } from "./resources.ts";
import { MEMBERS, DIARIES } from "./tokens.ts";

@Module({})
class ReadingModule {}

export function readingModule(infrastructure: DynamicModule): DynamicModule {
  return {
    module: ReadingModule,
    imports: [infrastructure],
    providers: [
      {
        provide: Reading,
        inject: [DIARIES, MEMBERS],
        useFactory: (
          diaries: Resources["diaries"],
          members: Resources["members"],
        ) => new Reading(diaries, members),
      },
    ],
    exports: [Reading],
  };
}
