import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { Journal } from "../../application/journal.ts";
import { Reading } from "../../application/reading.ts";
import { contentSchema, type Content } from "../../domain/diary.ts";
import { dateRange } from "../../../../shared/domain/date.ts";
import type { Member } from "../../../membership/domain/membership.ts";
import { CurrentMember } from "../../../../interfaces/http/session.guard.ts";
import { ZodPipe } from "../../../../interfaces/http/validation.pipe.ts";

const submission = z.object({ version: z.number().int(), requestId: z.uuid() });

@Controller("api")
export class JournalController {
  constructor(
    @Inject(Journal) private readonly journal: Journal,
    @Inject(Reading) private readonly reading: Reading,
  ) {}
  @Post("diaries")
  @HttpCode(201)
  create(
    @CurrentMember() member: Member,
    @Body(new ZodPipe(contentSchema)) input: Content,
  ) {
    return this.journal.create(member.id, input);
  }
  @Get("diaries/mine")
  mine(@CurrentMember() member: Member) {
    return this.journal.mine(member.id);
  }
  @Get("diaries/:id")
  get(
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @CurrentMember() member: Member,
  ) {
    return this.journal.get(id, member.id);
  }
  @Post("diaries/:id/save")
  @HttpCode(200)
  save(
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @CurrentMember() member: Member,
    @Body(new ZodPipe(contentSchema)) input: Content,
    @Body("version") version: unknown,
  ) {
    return this.journal.save(id, member.id, input, version);
  }
  @Post("diaries/:id/delete")
  @HttpCode(200)
  delete(
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @CurrentMember() member: Member,
    @Body("version") version: unknown,
  ) {
    this.journal.delete(id, member.id, version);
    return { ok: true };
  }
  @Post("diaries/:id/submit")
  @HttpCode(200)
  submit(
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @CurrentMember() member: Member,
    @Body(new ZodPipe(submission)) input: z.infer<typeof submission>,
  ) {
    return this.journal.submit(id, member.id, input);
  }
  @Get("diary-events")
  events(@CurrentMember() member: Member) {
    return this.journal.events(member.id);
  }
  @Get("team-diaries")
  team(
    @CurrentMember() member: Member,
    @Query() query: Record<string, unknown>,
  ) {
    return this.reading.published(member.id, dateRange(query), {
      memberId: query.memberId ? z.uuid().parse(query.memberId) : undefined,
      projectId: query.projectId ? z.uuid().parse(query.projectId) : undefined,
      complete: true,
    });
  }
  @Get("team-diaries/:id")
  published(
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @CurrentMember() member: Member,
  ) {
    return this.reading.diary(id, member.id);
  }
  @Get("members")
  members(@CurrentMember() member: Member) {
    return this.reading.members(member.id);
  }
}
