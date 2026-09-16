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
import { Attachments } from "../../application/attachments.ts";
import { DomainError } from "../../domain/errors.ts";
import type { Member } from "../../domain/membership.ts";
import { Anonymous, CurrentMember } from "./session.guard.ts";
import { ZodPipe } from "./validation.pipe.ts";

const uploadSchema = z.object({
  version: z.number().int(),
  requestId: z.uuid(),
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\\/\x00-\x1f\x7f]+$/),
  base64: z.string().max(28_000_000),
});

function send(res: Response, file: { name: string; bytes: Uint8Array }) {
  res
    .set("Content-Type", "application/octet-stream")
    .set(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    )
    .set("Cache-Control", "no-store")
    .send(Buffer.from(file.bytes));
}

@Controller("api")
export class AttachmentsController {
  constructor(@Inject(Attachments) private readonly attachments: Attachments) {}

  @Post("diaries/:id/entries/:entryId/attachments")
  @HttpCode(201)
  upload(
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @Param("entryId", new ZodPipe(z.uuid())) entryId: string,
    @CurrentMember() member: Member,
    @Body(new ZodPipe(uploadSchema)) input: z.infer<typeof uploadSchema>,
  ) {
    if (
      input.base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)
    )
      throw new DomainError("invalid", "文件内容不完整，请重新上传。");
    return this.attachments.upload(
      id,
      entryId,
      member.id,
      input,
      Buffer.from(input.base64, "base64"),
    );
  }

  @Post("diaries/:id/attachments/cancel")
  @HttpCode(200)
  cancel(
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @CurrentMember() member: Member,
    @Body("requestId", new ZodPipe(z.uuid())) requestId: string,
  ) {
    return this.attachments.cancel(id, member.id, requestId);
  }

  @Get("attachments/:id")
  read(
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @CurrentMember() member: Member,
    @Res() response: Response,
  ) {
    send(response, this.attachments.read(id, member.id));
  }

  @Get("public/:token/attachments/:id")
  @Anonymous()
  readPublic(
    @Param("token", new ZodPipe(z.string().max(128))) token: string,
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @Res() response: Response,
  ) {
    send(response, this.attachments.readPublic(token, id));
  }
}
