import type { Express, Response } from "express";
import { z } from "zod";
import type { Membership } from "../../application/membership.ts";
import { WEEK } from "../../domain/membership.ts";
import { authenticator, cookieToken } from "./context.ts";
const credentials = z.object({
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(128),
});
const registration = credentials.extend({
  name: z.string().trim().min(1).max(60),
});
const cookieOptions = {
  httpOnly: true,
  sameSite: "strict" as const,
  path: "/",
};
function session(
  response: Response,
  result: Awaited<ReturnType<Membership["login"]>>,
  status = 200,
) {
  response.cookie("daily_session", result.token, {
    ...cookieOptions,
    maxAge: WEEK,
  });
  response.status(status).json({ member: result.member, team: result.team });
}
export function membershipRoutes(app: Express, membership: Membership) {
  const authenticate = authenticator(membership);
  app.get("/api/setup/status", (_req, res) => {
    res.json({ needsSetup: !membership.team() });
  });
  app.post("/api/setup", async (req, res) => {
    const input = registration
      .extend({
        teamName: z.string().trim().min(1).max(60),
        setupKey: z.string(),
      })
      .parse(req.body);
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      req.socket.remoteAddress ?? "",
    );
    session(res, await membership.setup(input, local), 201);
  });
  app.get("/api/me", (req, res) => {
    res.json({ member: authenticate(req), team: membership.team() });
  });
  app.post("/api/login", async (req, res) => {
    session(
      res,
      await membership.login(credentials.parse(req.body), cookieToken(req)),
    );
  });
  app.post("/api/logout", (req, res) => {
    membership.logout(cookieToken(req));
    res.clearCookie("daily_session", cookieOptions);
    res.json({ ok: true });
  });
  app.post("/api/invitations", (req, res) => {
    res.status(201).json(membership.invite(authenticate(req).id));
  });
  app.get("/api/invitations", (req, res) => {
    res.json({ invitations: membership.invitations(authenticate(req).id) });
  });
  app.post("/api/invitations/preview", (req, res) => {
    res.json(
      membership.previewInvitation(
        z.string().min(1).max(128).parse(req.body.token),
      ),
    );
  });
  app.post("/api/invitations/:id/revoke", (req, res) => {
    const member = authenticate(req);
    membership.revokeInvitation(z.uuid().parse(req.params.id), member.id);
    res.json({ ok: true });
  });
  app.post("/api/join", async (req, res) => {
    session(
      res,
      await membership.join(
        registration
          .extend({ token: z.string().min(1).max(128) })
          .parse(req.body),
      ),
      201,
    );
  });
}
