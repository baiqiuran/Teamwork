import type { Response } from "express";
import { z } from "zod";
import type { Membership } from "../../application/membership.ts";
import { WEEK } from "../../domain/membership.ts";

export const credentials = z.object({
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(128),
});
export const registration = credentials.extend({
  name: z.string().trim().min(1).max(60),
});
export const cookieOptions = {
  httpOnly: true,
  sameSite: "strict" as const,
  path: "/",
};
export function sessionResponse(
  response: Response,
  result: Awaited<ReturnType<Membership["login"]>>,
) {
  response.cookie("daily_session", result.token, {
    ...cookieOptions,
    maxAge: WEEK,
  });
  return { member: result.member, team: result.team };
}
