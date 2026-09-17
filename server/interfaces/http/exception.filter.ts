import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { DomainError } from "../../domain/errors.ts";
import { HttpError } from "./http-error.ts";

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) return;
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: "请检查输入内容及长度限制。" });
      return;
    }
    if (error instanceof DomainError) {
      const status = {
        invalid: 400,
        unauthenticated: 401,
        forbidden: 403,
        "not-found": 404,
        conflict: 409,
        gone: 410,
        "operation-id-conflict": 409,
        "version-conflict": 409,
        "history-locked": 409,
        archived: 409,
        "share-closed": 410,
      }[error.code];
      response
        .status(status)
        .json({ error: error.message, details: error.details });
      return;
    }
    if (error instanceof HttpError) {
      if (
        error.status === 429 &&
        error.details &&
        typeof error.details === "object" &&
        "retryAfter" in error.details
      )
        response.set("Retry-After", String(error.details.retryAfter));
      response
        .status(error.status)
        .json({ error: error.message, details: error.details });
      return;
    }
    if (error instanceof SyntaxError) {
      response.status(400).json({ error: "请求格式不正确。" });
      return;
    }
    if (
      error &&
      typeof error === "object" &&
      "type" in error &&
      error.type === "entity.too.large"
    ) {
      response.status(413).json({ error: "请求内容超过大小限制。" });
      return;
    }
    if (error instanceof HttpException && error.getStatus() === 404) {
      response.status(404).json({ error: "未找到该接口。" });
      return;
    }
    console.error(
      "Request failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    response.status(500).json({ error: "操作未完成，请稍后重试。" });
  }
}
