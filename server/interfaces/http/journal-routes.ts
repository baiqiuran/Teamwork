import type { Express } from "express";
import { z } from "zod";
import { contentSchema, dateRange } from "../../domain/diary.ts";
import { authenticator, type Services } from "./context.ts";
export function journalRoutes(
  app: Express,
  { membership, journal, reading }: Services,
) {
  const authenticate = authenticator(membership);
  app.post("/api/diaries", (req, res) => {
    const member = authenticate(req);
    res
      .status(201)
      .json(journal.create(member.id, contentSchema.parse(req.body)));
  });
  app.get("/api/diaries/mine", (req, res) => {
    res.json(journal.mine(authenticate(req).id));
  });
  app.get("/api/diaries/:id", (req, res) => {
    const member = authenticate(req);
    res.json(journal.get(z.uuid().parse(req.params.id), member.id));
  });
  app.post("/api/diaries/:id/save", (req, res) => {
    const member = authenticate(req);
    res.json(
      journal.save(
        z.uuid().parse(req.params.id),
        member.id,
        contentSchema.parse(req.body),
        req.body.version,
      ),
    );
  });
  app.post("/api/diaries/:id/delete", (req, res) => {
    const member = authenticate(req);
    journal.delete(z.uuid().parse(req.params.id), member.id, req.body.version);
    res.json({ ok: true });
  });
  app.post("/api/diaries/:id/submit", (req, res) => {
    const member = authenticate(req);
    res.json(
      journal.submit(
        z.uuid().parse(req.params.id),
        member.id,
        z
          .object({ version: z.number().int(), requestId: z.uuid() })
          .parse(req.body),
      ),
    );
  });
  app.get("/api/diary-events", (req, res) => {
    authenticate(req);
    res.json(journal.events());
  });
  app.get("/api/team-diaries", (req, res) => {
    authenticate(req);
    res.json(
      reading.published(dateRange(req.query), {
        memberId: req.query.memberId
          ? z.uuid().parse(req.query.memberId)
          : undefined,
        projectId: req.query.projectId
          ? z.uuid().parse(req.query.projectId)
          : undefined,
        complete: true,
      }),
    );
  });
  app.get("/api/team-diaries/:id", (req, res) => {
    authenticate(req);
    res.json(reading.diary(z.uuid().parse(req.params.id)));
  });
  app.get("/api/members", (req, res) => {
    authenticate(req);
    res.json(reading.members());
  });
}
