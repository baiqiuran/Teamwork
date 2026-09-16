import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { Membership } from "../../application/membership.ts";
import type { Member } from "../../domain/membership.ts";
import { Anonymous, CurrentMember } from "./session.guard.ts";
import { cookieToken } from "./context.ts";
import {
  cookieOptions,
  credentials,
  registration,
  sessionResponse,
} from "./access-contract.ts";
import { ZodPipe } from "./validation.pipe.ts";

const setupInput = registration.extend({
  teamName: z.string().trim().min(1).max(60),
  setupKey: z.string(),
});

@Controller("api")
export class AccessController {
  constructor(@Inject(Membership) private readonly membership: Membership) {}
  @Get("setup/status")
  @Anonymous()
  status() {
    return { needsSetup: !this.membership.team() };
  }
  @Post("setup")
  @HttpCode(201)
  @Anonymous()
  async setup(
    @Body(new ZodPipe(setupInput)) input: z.infer<typeof setupInput>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      request.socket.remoteAddress ?? "",
    );
    return sessionResponse(response, await this.membership.setup(input, local));
  }
  @Get("me")
  me(@CurrentMember() member: Member) {
    return { member, team: this.membership.team() };
  }
  @Post("login")
  @HttpCode(200)
  @Anonymous()
  async login(
    @Body(new ZodPipe(credentials)) input: z.infer<typeof credentials>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return sessionResponse(
      response,
      await this.membership.login(input, cookieToken(request)),
    );
  }
  @Post("logout")
  @HttpCode(200)
  @Anonymous()
  logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.membership.logout(cookieToken(request));
    response.clearCookie("daily_session", cookieOptions);
    return { ok: true };
  }
}
