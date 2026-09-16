import express, { type Express, type ErrorRequestHandler } from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { HttpError } from "./http-error.ts";
import type { Services } from "./context.ts";

export function configureHttp(app: Express, services: Services) {
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
  // Preserve the JSON contract before Nest wraps parser errors in HttpException.
  const parseError: ErrorRequestHandler = (error, _request, _response, next) =>
    next(
      error instanceof SyntaxError
        ? new HttpError(400, "请求格式不正确。")
        : error,
    );
  app.use(parseError);
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
}
