import type { Express, Response } from "express";
import { z } from "zod";
import { DomainError } from "../../domain/errors.ts";
import { authenticator, type Services } from "./context.ts";
const uploadSchema = z.object({
  version: z.number().int(),
  requestId: z.uuid(),
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\\/\x00-\x1f\x7f]+$/),
  base64: z.string().max(28_000_000),
});
function send(res: Response, file: { name: string; bytes: Uint8Array }) {
  res
    .set("Content-Type", "application/octet-stream")
    .set(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    )
    .set("Cache-Control", "no-store")
    .send(Buffer.from(file.bytes));
}
export function attachmentRoutes(
  app: Express,
  { membership, attachments }: Services,
) {
  const authenticate = authenticator(membership);
  app.post("/api/diaries/:id/entries/:entryId/attachments", (req, res) => {
    const member = authenticate(req),
      input = uploadSchema.parse(req.body);
    if (
      input.base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)
    )
      throw new DomainError("invalid", "文件内容不完整，请重新上传。");
    res
      .status(201)
      .json(
        attachments.upload(
          z.uuid().parse(req.params.id),
          z.uuid().parse(req.params.entryId),
          member.id,
          input,
          Buffer.from(input.base64, "base64"),
        ),
      );
  });
  app.post("/api/diaries/:id/attachments/cancel", (req, res) => {
    const member = authenticate(req);
    res.json(
      attachments.cancel(
        z.uuid().parse(req.params.id),
        member.id,
        z.uuid().parse(req.body.requestId),
      ),
    );
  });
  app.get("/api/attachments/:id", (req, res) => {
    const member = authenticate(req);
    send(res, attachments.read(z.uuid().parse(req.params.id), member.id));
  });
  app.get("/api/public/:token/attachments/:id", (req, res) => {
    send(
      res,
      attachments.readPublic(
        z.string().max(128).parse(req.params.token),
        z.uuid().parse(req.params.id),
      ),
    );
  });
}
