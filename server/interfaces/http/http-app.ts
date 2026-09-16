import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { DomainError } from "../../domain/errors.ts";
import { HttpError } from "./http-error.ts";
import { membershipRoutes } from "./membership-routes.ts";
import { journalRoutes } from "./journal-routes.ts";
import { workRoutes } from "./work-routes.ts";
import { sharingRoutes } from "./sharing-routes.ts";
import { attachmentRoutes } from "./attachment-routes.ts";
import type { Services } from "./context.ts";

export function createHttpApp(services: Services) {
  const app = express();
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { "upgrade-insecure-requests": null },
      },
      referrerPolicy: { policy: "no-referrer" },
    }),
  );
  app.use("/api", (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api", (request, _response, next) => {
    const host = request.get("host") ?? "";
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host))
      throw new HttpError(403, "当前应用仅允许本机访问。");
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      if (request.get("origin") !== `${request.protocol}://${host}`)
        throw new HttpError(403, "请求来源不匹配，请从应用页面重试。");
      if (!request.is("application/json"))
        throw new HttpError(415, "请使用 JSON 请求。");
    }
    next();
  });
  app.use(
    "/api/diaries/:id/entries/:entryId/attachments",
    express.json({ limit: "28mb" }),
  );
  app.use(express.json({ limit: "4mb" }));
  const authLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "尝试次数过多，请 10 分钟后重试。" },
  });
  app.use(
    ["/api/setup", "/api/login", "/api/join"],
    (request, response, next) =>
      request.method === "POST" ? authLimiter(request, response, next) : next(),
  );

  membershipRoutes(app, services.membership);
  journalRoutes(app, services);
  workRoutes(app, services);
  sharingRoutes(app, services);
  attachmentRoutes(app, services);
  app.use("/api", (_request, response) => {
    response.status(404).json({ error: "未找到该接口。" });
  });
  const errorHandler: ErrorRequestHandler = (
    error,
    _request,
    response,
    _next,
  ) => {
    if (error instanceof z.ZodError) {
      response.status(400).json({
        error: "请检查输入内容及长度限制。",
      });
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
      }[error.code];
      response
        .status(status)
        .json({ error: error.message, details: error.details });
      return;
    }
    if (error instanceof HttpError) {
      response
        .status(error.status)
        .json({ error: error.message, details: error.details });
      return;
    }
    if (error instanceof SyntaxError) {
      response.status(400).json({ error: "请求格式不正确。" });
      return;
    }
    console.error("Request failed:", error);
    response.status(500).json({ error: "操作未完成，请稍后重试。" });
  };
  app.use(errorHandler);
  return app;
}
