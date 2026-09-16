import type { Request } from "express";
import type { Attachments } from "../../application/attachments.ts";
import type { Journal } from "../../application/journal.ts";
import type { Membership } from "../../application/membership.ts";
import type { Reading } from "../../application/reading.ts";
import type { Sharing } from "../../application/sharing.ts";
import type { Work } from "../../application/work.ts";
export interface Services {
  membership: Membership;
  journal: Journal;
  work: Work;
  sharing: Sharing;
  attachments: Attachments;
  reading: Reading;
}
export const cookieToken = (request: Request) =>
  (request.headers.cookie ?? "")
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("daily_session="))
    ?.slice(14) ?? "";
export function authenticator(membership: Membership) {
  return (request: Request) => membership.authenticate(cookieToken(request));
}
