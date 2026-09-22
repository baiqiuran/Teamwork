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
import { Work } from "../../application/work.ts";
import type { Member } from "../../../membership/domain/membership.ts";
import { dateRange } from "../../../../shared/domain/date.ts";
import { definitionSchema } from "../../domain/work.ts";
import { CurrentMember } from "../../../../interfaces/http/session.guard.ts";
import { ZodPipe } from "../../../../interfaces/http/validation.pipe.ts";

type Definition = z.infer<typeof definitionSchema>;

@Controller("api")
export class WorkController {
  constructor(@Inject(Work) private readonly work: Work) {}

  @Get("projects")
  projects(@CurrentMember() member: Member) {
    return this.work.projects(member.id);
  }

  @Post("projects")
  @HttpCode(201)
  createProject(
    @CurrentMember() member: Member,
    @Body(new ZodPipe(definitionSchema)) input: Definition,
  ) {
    return this.work.createProject(member.id, input);
  }

  @Get("projects/:id")
  project(
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @CurrentMember() member: Member,
  ) {
    return this.work.getProject(id, member.id);
  }

  @Post("projects/:id/save")
  @HttpCode(200)
  saveProject(
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @CurrentMember() member: Member,
    @Body(new ZodPipe(definitionSchema)) input: Definition,
  ) {
    return this.work.reviseProject(id, member.id, input);
  }

  @Post("projects/:id/archive")
  @HttpCode(200)
  archiveProject(
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @CurrentMember() member: Member,
    @Body("archived", new ZodPipe(z.boolean())) archived: boolean,
  ) {
    return this.work.archiveProject(id, member.id, archived);
  }

  @Get("projects/:id/progress")
  projectProgress(
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @CurrentMember() member: Member,
    @Query() query: Record<string, unknown>,
  ) {
    return this.work.projectProgress(id, member.id, dateRange(query));
  }

  @Get("projects/:id/tasks")
  tasks(
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @CurrentMember() member: Member,
  ) {
    return this.work.tasks(id, member.id);
  }

  @Post("projects/:id/tasks")
  @HttpCode(201)
  createTask(
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @CurrentMember() member: Member,
    @Body(new ZodPipe(definitionSchema)) input: Definition,
  ) {
    return this.work.createTask(id, member.id, input);
  }

  @Get("tasks/:id")
  task(
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @CurrentMember() member: Member,
  ) {
    return this.work.getTask(id, member.id);
  }

  @Post("tasks/:id/save")
  @HttpCode(200)
  saveTask(
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @CurrentMember() member: Member,
    @Body(new ZodPipe(definitionSchema)) input: Definition,
  ) {
    return this.work.reviseTask(id, member.id, input);
  }

  @Post("tasks/:id/archive")
  @HttpCode(200)
  archiveTask(
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @CurrentMember() member: Member,
    @Body("archived", new ZodPipe(z.boolean())) archived: boolean,
  ) {
    return this.work.archiveTask(id, member.id, archived);
  }

  @Get("tasks/:id/progress")
  taskProgress(
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @CurrentMember() member: Member,
    @Query() query: Record<string, unknown>,
  ) {
    return this.work.taskProgress(id, member.id, dateRange(query));
  }

  @Get("tasks/:id/events")
  events(
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @CurrentMember() member: Member,
  ) {
    return this.work.events(id, member.id);
  }
}
