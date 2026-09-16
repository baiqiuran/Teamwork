import { Module, type DynamicModule } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { Membership } from "../application/membership.ts";
import { Journal } from "../application/journal.ts";
import { Work } from "../application/work.ts";
import { Sharing } from "../application/sharing.ts";
import { Attachments } from "../application/attachments.ts";
import { Reading } from "../application/reading.ts";
import { AccessController } from "../interfaces/http/access.controller.ts";
import { InvitationsController } from "../interfaces/http/invitations.controller.ts";
import { WorkController } from "../interfaces/http/work.controller.ts";
import { JournalController } from "../interfaces/http/journal.controller.ts";
import { SharingController } from "../interfaces/http/sharing.controller.ts";
import { AttachmentsController } from "../interfaces/http/attachments.controller.ts";
import { SessionGuard } from "../interfaces/http/session.guard.ts";
import type { Resources } from "./resources.ts";

@Module({})
class InfrastructureModule {}
@Module({})
class ReadingModule {}
@Module({})
class MembershipModule {}
@Module({})
class WorkModule {}
@Module({})
class JournalModule {}
@Module({})
class SharingModule {}
@Module({})
class AttachmentsModule {}
@Module({})
class ApplicationModule {}

const MEMBERS = Symbol("MembershipRepository"),
  DIARIES = Symbol("DiaryRepository"),
  WORK = Symbol("WorkRepository"),
  SHARES = Symbol("SharingRepository"),
  ATTACHMENTS = Symbol("AttachmentRepository"),
  RUNTIME = Symbol("Runtime"),
  SECURITY = Symbol("Security"),
  FILES = Symbol("FileStorage"),
  SETUP_KEY = Symbol("SetupKey");

export function applicationModule(resources: Resources): DynamicModule {
  const infrastructure: DynamicModule = {
    module: InfrastructureModule,
    providers: [
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
  const reading: DynamicModule = {
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
  const membership: DynamicModule = {
    module: MembershipModule,
    imports: [infrastructure],
    controllers: [AccessController, InvitationsController],
    providers: [
      {
        provide: Membership,
        inject: [MEMBERS, RUNTIME, SECURITY, SETUP_KEY],
        useFactory: (
          members: Resources["members"],
          runtime: Resources["runtime"],
          security: Resources["security"],
          setupKey: string,
        ) => new Membership(members, runtime, security, setupKey),
      },
      {
        provide: APP_GUARD,
        inject: [Membership, Reflector],
        useFactory: (members: Membership, reflector: Reflector) =>
          new SessionGuard(members, reflector),
      },
    ],
  };
  const work: DynamicModule = {
    module: WorkModule,
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
  const journal: DynamicModule = {
    module: JournalModule,
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
  const sharing: DynamicModule = {
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
  const attachments: DynamicModule = {
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
  return {
    module: ApplicationModule,
    imports: [membership, work, journal, sharing, attachments],
  };
}
