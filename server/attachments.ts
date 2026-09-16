import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, extname } from "node:path";
import { z } from "zod";
import { digest } from "./security.ts";
import { HttpError } from "./http-error.ts";
import type { JournalContext, DiaryRow, Content } from "./journal.ts";
import { readPublished } from "./published.ts";
interface FileRow {
  id: string;
  diary_id: string;
  entry_id: string;
  member_id: string;
  name: string;
  size: number;
  request_id: string;
  fingerprint: string;
}
interface DiaryAccess {
  owned: (req: Request) => DiaryRow;
  writable: (row: DiaryRow) => void;
  checkVersion: (row: DiaryRow, version: unknown) => void;
  view: (row: DiaryRow) => unknown;
}
export function installAttachments(
  app: Express,
  context: JournalContext,
  access: DiaryAccess,
  directory: string,
) {
  const { db, now, authenticate, transaction } = context;
  mkdirSync(directory, { recursive: true });
  db.exec(
    `CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, diary_id TEXT NOT NULL, entry_id TEXT NOT NULL, member_id TEXT NOT NULL REFERENCES members(id), name TEXT NOT NULL, size INTEGER NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, UNIQUE(member_id, request_id));`,
  );
  function file(id: string) {
    const row = db
      .prepare("SELECT * FROM attachments WHERE id = ?")
      .get(id) as unknown as FileRow | undefined;
    if (!row) throw new HttpError(404, "未找到附件。");
    return row;
  }
  const metadata = (row: FileRow) => ({
    id: row.id,
    name: row.name,
    size: row.size,
  });
  function normalize(content: Content, diaryId: string, memberId: string) {
    for (const entry of content.entries) {
      if (!entry.attachments) continue;
      const ids = new Set<string>();
      entry.attachments = entry.attachments.map((ref) => {
        const row = file(ref.id);
        if (
          row.diary_id !== diaryId ||
          row.entry_id !== entry.id ||
          row.member_id !== memberId
        )
          throw new HttpError(404, "未找到附件。");
        if (ids.has(row.id)) throw new HttpError(400, "不能重复添加同一附件。");
        ids.add(row.id);
        return metadata(row);
      });
    }
  }
  const has = (content: Content, id: string) =>
    content.entries.some((e) => e.attachments?.some((a) => a.id === id));
  function send(res: Response, row: FileRow) {
    res
      .set("Content-Type", "application/octet-stream")
      .set(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      )
      .set("Cache-Control", "no-store")
      .sendFile(resolve(directory, row.id));
  }
  app.post("/api/diaries/:id/entries/:entryId/attachments", (req, res) => {
    const owner = authenticate(req);
    const row = access.owned(req);
    access.writable(row);
    const input = z
      .object({
        version: z.number().int(),
        requestId: z.uuid(),
        name: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[^\\/\x00-\x1f\x7f]+$/),
        base64: z.string().max(28_000_000),
      })
      .parse(req.body);
    if (
      ![
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
        ".pdf",
        ".txt",
        ".csv",
        ".docx",
        ".xlsx",
        ".pptx",
      ].includes(extname(input.name).toLowerCase())
    )
      throw new HttpError(400, "不支持此文件类型。");
    if (
      input.base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)
    )
      throw new HttpError(400, "文件内容不完整，请重新上传。");
    const buffer = Buffer.from(input.base64, "base64");
    if (!buffer.length || buffer.length > 20 * 1024 * 1024)
      throw new HttpError(400, "单个文件须为 1 字节至 20 MB。");
    const fingerprint = digest(
      `${row.id}:${req.params.entryId}:${input.name}:${input.base64}`,
    );
    const previous = db
      .prepare(
        "SELECT * FROM attachments WHERE member_id = ? AND request_id = ?",
      )
      .get(owner.id, input.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new HttpError(409, "上传标识已使用。");
      res.status(201).json(access.view(row));
      return;
    }
    access.checkVersion(row, input.version);
    const content = JSON.parse(row.draft) as Content;
    const entry = content.entries.find((e) => e.id === req.params.entryId);
    if (!entry) throw new HttpError(404, "未找到工作条目，请先保存草稿。");
    if ((entry.attachments?.length ?? 0) >= 10)
      throw new HttpError(400, "每条工作最多 10 个附件。");
    const id = randomUUID();
    const path = resolve(directory, id);
    writeFileSync(path, buffer, { flag: "wx" });
    try {
      transaction(() => {
        db.prepare(
          "INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          id,
          row.id,
          entry.id,
          owner.id,
          input.name,
          buffer.length,
          input.requestId,
          fingerprint,
        );
        entry.attachments = [
          ...(entry.attachments ?? []),
          { id, name: input.name, size: buffer.length },
        ];
        db.prepare(
          "UPDATE diaries SET draft = ?, version = version + 1, updated_at = ? WHERE id = ?",
        ).run(JSON.stringify(content), now(), row.id);
      });
    } catch (error) {
      unlinkSync(path);
      throw error;
    }
    res
      .status(201)
      .json(
        access.view(
          db
            .prepare("SELECT * FROM diaries WHERE id = ?")
            .get(row.id) as unknown as DiaryRow,
        ),
      );
  });
  app.get("/api/attachments/:id", (req, res) => {
    const owner = authenticate(req),
      row = file(z.uuid().parse(req.params.id));
    const diary = db
      .prepare("SELECT * FROM diaries WHERE id = ?")
      .get(row.diary_id) as unknown as DiaryRow | undefined;
    if (
      !diary ||
      (!(
        diary.author_id === owner.id && has(JSON.parse(diary.draft), row.id)
      ) &&
        !(diary.published && has(JSON.parse(diary.published), row.id)))
    )
      throw new HttpError(404, "未找到附件。");
    send(res, row);
  });
  app.get("/api/public/:token/attachments/:id", (req, res) => {
    const share = db
      .prepare("SELECT * FROM shares WHERE token = ?")
      .get(z.string().max(128).parse(req.params.token));
    if (!share || share.closed_at !== null)
      throw new HttpError(410, "此公开链接无效或已关闭。");
    if (!JSON.parse(String(share.modules)).includes("progress"))
      throw new HttpError(404, "未找到附件。");
    const id = z.uuid().parse(req.params.id);
    const records = readPublished(
      db,
      { from: String(share.from_date), to: String(share.to_date) },
      {
        projectId:
          share.type === "project" ? String(share.target_id) : undefined,
        taskId: share.type === "task" ? String(share.target_id) : undefined,
      },
    );
    if (!records.some((r) => has(r.published, id)))
      throw new HttpError(404, "未找到附件。");
    send(res, file(id));
  });
  return { normalize };
}
