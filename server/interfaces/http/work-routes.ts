import type { Express } from "express";
import { z } from "zod";
import { dateRange } from "../../domain/diary.ts";
import { definitionSchema } from "../../domain/work.ts";
import { authenticator, type Services } from "./context.ts";
export function workRoutes(app: Express, { membership, work }: Services) {
  const authenticate = authenticator(membership);
  app.get("/api/projects", (req, res) => {
    authenticate(req);
    res.json(work.projects());
  });
  app.post("/api/projects", (req, res) => {
    const member = authenticate(req);
    res
      .status(201)
      .json(work.createProject(member.id, definitionSchema.parse(req.body)));
  });
  app.get("/api/projects/:id", (req, res) => {
    authenticate(req);
    res.json(work.getProject(z.uuid().parse(req.params.id)));
  });
  app.post("/api/projects/:id/save", (req, res) => {
    const member = authenticate(req);
    res.json(
      work.reviseProject(
        z.uuid().parse(req.params.id),
        member.id,
        definitionSchema.parse(req.body),
      ),
    );
  });
  app.post("/api/projects/:id/archive", (req, res) => {
    const member = authenticate(req);
    res.json(
      work.archiveProject(
        z.uuid().parse(req.params.id),
        member.id,
        z.boolean().parse(req.body.archived),
      ),
    );
  });
  app.get("/api/projects/:id/progress", (req, res) => {
    authenticate(req);
    res.json(
      work.projectProgress(z.uuid().parse(req.params.id), dateRange(req.query)),
    );
  });
  app.get("/api/projects/:id/tasks", (req, res) => {
    authenticate(req);
    res.json(work.tasks(z.uuid().parse(req.params.id)));
  });
  app.post("/api/projects/:id/tasks", (req, res) => {
    const member = authenticate(req);
    res
      .status(201)
      .json(
        work.createTask(
          z.uuid().parse(req.params.id),
          member.id,
          definitionSchema.parse(req.body),
        ),
      );
  });
  app.get("/api/tasks/:id", (req, res) => {
    authenticate(req);
    res.json(work.getTask(z.uuid().parse(req.params.id)));
  });
  app.post("/api/tasks/:id/save", (req, res) => {
    const member = authenticate(req);
    res.json(
      work.reviseTask(
        z.uuid().parse(req.params.id),
        member.id,
        definitionSchema.parse(req.body),
      ),
    );
  });
  app.post("/api/tasks/:id/archive", (req, res) => {
    const member = authenticate(req);
    res.json(
      work.archiveTask(
        z.uuid().parse(req.params.id),
        member.id,
        z.boolean().parse(req.body.archived),
      ),
    );
  });
  app.get("/api/tasks/:id/progress", (req, res) => {
    authenticate(req);
    res.json(
      work.taskProgress(z.uuid().parse(req.params.id), dateRange(req.query)),
    );
  });
  app.get("/api/tasks/:id/events", (req, res) => {
    authenticate(req);
    res.json(work.events(z.uuid().parse(req.params.id)));
  });
}
