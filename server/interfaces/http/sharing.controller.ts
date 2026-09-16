import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { z } from "zod";
import { Sharing } from "../../application/sharing.ts";
import type { Member } from "../../domain/membership.ts";
import { Anonymous, CurrentMember } from "./session.guard.ts";
import { ZodPipe } from "./validation.pipe.ts";

const shareSchema = z.object({
  type: z.enum(["diary", "project", "task"]),
  targetId: z.uuid().optional(),
  from: z.iso.date(),
  to: z.iso.date(),
  modules: z
    .array(z.enum(["overview", "tasks", "progress"]))
    .min(1)
    .max(3)
    .default(["progress"]),
});

@Controller("api")
export class SharingController {
  constructor(@Inject(Sharing) private readonly sharing: Sharing) {}

  @Post("shares")
  @HttpCode(201)
  create(
    @CurrentMember() member: Member,
    @Body(new ZodPipe(shareSchema)) input: z.infer<typeof shareSchema>,
  ) {
    return this.sharing.create(member.id, input);
  }
  @Get("shares")
  mine(@CurrentMember() member: Member) {
    return this.sharing.mine(member.id);
  }

  @Post("shares/:id/close")
  @HttpCode(200)
  close(
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @CurrentMember() member: Member,
  ) {
    this.sharing.close(id, member.id);
    return { ok: true };
  }

  @Get("public/:token")
  @Anonymous()
  read(@Param("token", new ZodPipe(z.string().max(128))) token: string) {
    return this.sharing.read(token);
  }
}
