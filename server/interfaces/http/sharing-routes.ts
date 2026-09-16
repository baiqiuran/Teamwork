import type { Express } from "express";
import { z } from "zod";
import { authenticator, type Services } from "./context.ts";
const shareSchema = z.object({
  type: z.enum(["diary", "project", "task"]),
  targetId: z.uuid().optional(),
  from: z.iso.date(),
  to: z.iso.date(),
  modules: z
    .array(z.enum(["overview", "tasks", "progress"]))
    .min(1)
    .max(3)
    .default(["progress"]),
});
export function sharingRoutes(app: Express, { membership, sharing }: Services) {
  const authenticate = authenticator(membership);
  app.post("/api/shares", (req, res) => {
    const member = authenticate(req);
    res
      .status(201)
      .json(sharing.create(member.id, shareSchema.parse(req.body)));
  });
  app.get("/api/shares", (req, res) => {
    res.json(sharing.mine(authenticate(req).id));
  });
  app.post("/api/shares/:id/close", (req, res) => {
    const member = authenticate(req);
    sharing.close(z.uuid().parse(req.params.id), member.id);
    res.json({ ok: true });
  });
  app.get("/api/public/:token", (req, res) => {
    res.json(sharing.read(z.string().max(128).parse(req.params.token)));
  });
}
