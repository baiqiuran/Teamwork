import express, { type Express, type ErrorRequestHandler } from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { HttpError } from "./http-error.ts";
import { SiteAddress } from "./site-address.ts";

export function configureHttp(
  app: Express,
  publicUrl?: string,
  mcpMaxBodyBytes = 16777216,
) {
  if (
    !Number.isInteger(mcpMaxBodyBytes) ||
    mcpMaxBodyBytes < 4194304 ||
    mcpMaxBodyBytes > 16777216
  )
    throw new Error("MCP 请求上限须为 4–16 MiB。");
  const site = new SiteAddress(publicUrl);
  if (publicUrl) app.set("trust proxy", "loopback");
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { "upgrade-insecure-requests": null },
      },
      referrerPolicy: { policy: "no-referrer" },
    }),
  );
  app.use(["/api", "/oauth", "/mcp"], (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });
  app.use(
    ["/api", "/mcp", "/oauth", "/.well-known"],
    (request, _response, next) => {
      const origin = site.forRequest(request);
      if (request.get("origin") && request.get("origin") !== origin)
        throw new HttpError(403, "请求来源不匹配。");
      next();
    },
  );
  app.use("/api", (request, _response, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      if (request.get("origin") !== site.forRequest(request))
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
  app.use("/mcp", express.json({ limit: mcpMaxBodyBytes }));
  app.use(express.json({ limit: "4mb" }));
  app.use(
    "/oauth/token",
    express.urlencoded({ extended: false, limit: "16kb" }),
  );
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
