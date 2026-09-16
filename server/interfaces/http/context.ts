import type { Request } from "express";
export const cookieToken = (request: Request) =>
  (request.headers.cookie ?? "")
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("daily_session="))
    ?.slice(14) ?? "";
