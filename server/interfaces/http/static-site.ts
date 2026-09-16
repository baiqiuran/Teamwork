import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express, { type Express } from "express";

export function staticSite(app: Express, directory: string) {
  const serve = express.static(directory, { index: false });
  app.use((request, response, next) => {
    if (request.path === "/api" || request.path.startsWith("/api/"))
      return next();
    serve(request, response, (error?: unknown) => {
      if (error) return next(error);
      if (request.method !== "GET" && request.method !== "HEAD") return next();
      const index = resolve(directory, "index.html");
      if (!existsSync(index)) {
        response.status(503).send("请先运行 npm run build。");
        return;
      }
      response.set("Cache-Control", "no-store").sendFile(index);
    });
  });
}
