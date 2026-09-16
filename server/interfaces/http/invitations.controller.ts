import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { Membership } from "../../application/membership.ts";
import type { Member } from "../../domain/membership.ts";
import { Anonymous, CurrentMember } from "./session.guard.ts";
import { registration, sessionResponse } from "./access-contract.ts";
import { ZodPipe } from "./validation.pipe.ts";

const joinInput = registration.extend({ token: z.string().min(1).max(128) });

@Controller("api")
export class InvitationsController {
  constructor(@Inject(Membership) private readonly membership: Membership) {}

  @Post("invitations")
  @HttpCode(201)
  invite(@CurrentMember() member: Member) {
    return this.membership.invite(member.id);
  }

  @Get("invitations")
  list(@CurrentMember() member: Member) {
    return { invitations: this.membership.invitations(member.id) };
  }

  @Post("invitations/preview")
  @HttpCode(200)
  @Anonymous()
  preview(
    @Body("token", new ZodPipe(z.string().min(1).max(128))) token: string,
  ) {
    return this.membership.previewInvitation(token);
  }

  @Post("invitations/:id/revoke")
  @HttpCode(200)
  revoke(
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @CurrentMember() member: Member,
  ) {
    this.membership.revokeInvitation(id, member.id);
    return { ok: true };
  }

  @Post("join")
  @HttpCode(201)
  @Anonymous()
  async join(
    @Body(new ZodPipe(joinInput)) input: z.infer<typeof joinInput>,
    @Res({ passthrough: true }) response: Response,
  ) {
    return sessionResponse(response, await this.membership.join(input));
  }
}
