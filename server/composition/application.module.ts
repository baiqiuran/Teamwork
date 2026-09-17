import { Module, type DynamicModule } from "@nestjs/common";
import type { Resources } from "./resources.ts";
import { infrastructureModule } from "./infrastructure.module.ts";
import { readingModule } from "./reading.module.ts";
import { membershipModule } from "./membership.module.ts";
import { workModule } from "./work.module.ts";
import { journalModule } from "./journal.module.ts";
import { sharingModule } from "./sharing.module.ts";
import { attachmentsModule } from "./attachments.module.ts";
import { aiModule } from "./ai.module.ts";

@Module({})
class ApplicationModule {}

export function applicationModule(resources: Resources): DynamicModule {
  const infrastructure = infrastructureModule(resources);
  const reading = readingModule(infrastructure);
  const membership = membershipModule(infrastructure);
  const work = workModule(infrastructure, reading);
  const journal = journalModule(infrastructure, reading);
  const sharing = sharingModule(infrastructure, reading);
  const attachments = attachmentsModule(infrastructure, sharing);
  const ai = aiModule(
    resources,
    infrastructure,
    reading,
    work,
    journal,
    sharing,
  );
  return {
    module: ApplicationModule,
    imports: [membership, work, journal, sharing, attachments, ai],
  };
}
