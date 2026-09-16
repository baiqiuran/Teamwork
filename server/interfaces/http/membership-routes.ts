import type { Express, Response } from "express";
import { z } from "zod";
import type { Membership } from "../../application/membership.ts";
import { authenticator } from "./context.ts";
import { registration, sessionResponse } from "./access-contract.ts";
function session(
  response: Response,
  result: Awaited<ReturnType<Membership["login"]>>,
  status: number,
) {
  response.status(status).json(sessionResponse(response, result));
}
export function membershipRoutes(app: Express, membership: Membership) {
  const authenticate = authenticator(membership);
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
