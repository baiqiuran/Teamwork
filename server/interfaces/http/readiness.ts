import type { Express } from "express";
import { timingSafeEqual } from "node:crypto";

export function readiness(
  app: Express,
  options: {
    version: string;
    token?: string;
    closing(): boolean;
    inspect(deep: boolean): { schema?: number; integrity?: string };
  },
) {
  app.get(["/health/ready", "/internal/health"], (request, response) => {
    const deep = request.path.toLowerCase() === "/internal/health";
    response.set("Cache-Control", "no-store");
    if (deep) {
      const actual = Buffer.from(request.get("X-Daily-Health") ?? "");
      const expected = Buffer.from(options.token ?? "");
      if (
        !expected.length ||
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual) ||
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          request.socket.remoteAddress ?? "",
        )
      ) {
        response.status(404).json({ error: "Not found" });
        return;
      }
    }
    try {
      if (options.closing()) throw new Error("Closing");
      const detail = options.inspect(deep);
      response.json({
        ready: true,
        version: options.version,
        ...(deep ? detail : {}),
      });
    } catch {
      response.status(503).json({ ready: false, version: options.version });
    }
  });
}
