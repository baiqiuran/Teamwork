import type { Request } from "express";
import { HttpError } from "./http-error.ts";
export class SiteAddress {
  readonly origin?: string;
  constructor(origin?: string) {
    if (origin) {
      const url = new URL(origin);
      if (
        url.origin !== origin ||
        (url.protocol !== "https:" &&
          !(
            url.protocol === "http:" &&
            ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
          ))
      )
        throw new Error(
          "DAILY_PUBLIC_URL 必须是 HTTPS 站点源地址（本机可用 HTTP）。",
        );
      this.origin = origin;
    }
  }
  forRequest(request: Request) {
    const host = request.get("host") ?? "";
    if (this.origin) {
      if (host !== new URL(this.origin).host)
        throw new HttpError(403, "目标 Host 不匹配。");
      return this.origin;
    }
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host))
      throw new HttpError(403, "当前应用仅允许本机访问。");
    return `http://${host}`;
  }
}
