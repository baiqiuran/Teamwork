import { z } from "zod";
import { DomainError } from "../../../shared/domain/errors.ts";

const text = (max: number) =>
  z.string().refine((value) => [...value].length <= max, `最多 ${max} 字`);
import { taskStatusSchema } from "../../work/domain/task-status.ts";
export const contentSchema = z
  .object({
    title: text(100),
    entries: z
      .array(
        z.object({
          id: z.uuid(),
          body: text(10_000),
          attachments: z
            .array(
              z.object({
                id: z.uuid(),
                name: z.string().optional(),
                size: z.number().optional(),
              }),
            )
            .max(10)
            .optional(),
          projectId: z.uuid().optional(),
          projectName: z.string().optional(),
          taskId: z.uuid().optional(),
          newTask: z
            .object({ name: z.string().max(100), description: text(10_000) })
            .optional(),
          taskName: z.string().optional(),
          taskStatus: taskStatusSchema.optional(),
          statusChange: z
            .object({
              status: taskStatusSchema,
              expectedVersion: z.number().int().positive(),
              resolution: z.enum(["keep", "apply"]).optional(),
            })
            .optional(),
        }),
      )
      .max(50),
  })
  .refine(
    (value) =>
      new Set(value.entries.map((entry) => entry.id)).size ===
      value.entries.length,
    "条目标识不能重复",
  );
export type Content = z.infer<typeof contentSchema>;
export type WorkEntry = Content["entries"][number];
import { beijingDate } from "../../../shared/domain/date.ts";
export interface DiaryState {
  id: string;
  authorId: string;
  draft: Content;
  version: number;
  createdAt: number;
  updatedAt: number;
  published: Content | null;
  firstSubmittedAt: number | null;
  submittedAt: number | null;
  diaryDate: string | null;
}
export class Diary {
  constructor(readonly state: DiaryState) {}
  static create(id: string, authorId: string, content: Content, now: number) {
    return new Diary({
      id,
      authorId,
      draft: contentSchema.parse(content),
      version: 1,
      createdAt: now,
      updatedAt: now,
      published: null,
      firstSubmittedAt: null,
      submittedAt: null,
      diaryDate: null,
    });
  }
  editable(now: number) {
    return !this.state.diaryDate || this.state.diaryDate === beijingDate(now);
  }
  assertWritable(now: number) {
    if (!this.editable(now))
      throw new DomainError(
        "history-locked",
        "历史日报已锁定，不能修改、重新提交或删除。",
      );
  }
  assertVersion(version: unknown) {
    if (version !== this.state.version)
      throw new DomainError(
        "version-conflict",
        "这份日报已在其他窗口更新，请重新打开后再编辑。",
        { diaryId: this.state.id, latestVersion: this.state.version },
      );
  }
  revise(content: Content, version: unknown, now: number) {
    this.assertWritable(now);
    this.assertVersion(version);
    this.state.draft = contentSchema.parse(content);
    this.state.version++;
    this.state.updatedAt = now;
  }
  submissionContent(now: number) {
    this.assertWritable(now);
    const content = contentSchema.parse(this.state.draft);
    content.entries = content.entries.filter(
      (entry) => entry.body.trim() || entry.attachments?.length,
    );
    if (!content.entries.length)
      throw new DomainError("invalid", "请至少填写一条工作内容后再提交。");
    return content;
  }
  publish(content: Content, now: number) {
    this.assertWritable(now);
    const validated = contentSchema.parse(content);
    this.state.published = structuredClone(validated);
    this.state.draft = validated;
    this.state.firstSubmittedAt ??= now;
    this.state.diaryDate ??= beijingDate(now);
    this.state.submittedAt = now;
    this.state.updatedAt = now;
    this.state.version++;
  }
  view(now: number) {
    return { ...this.state, editable: this.editable(now) };
  }
}
export interface ProgressFilter {
  projectId?: string;
  taskId?: string;
  memberId?: string;
  complete?: boolean;
}
export function projectPublishedContent(
  content: Content,
  filter: ProgressFilter,
): Content | null {
  const entries = content.entries.filter(
    (entry) =>
      (!filter.projectId || entry.projectId === filter.projectId) &&
      (!filter.taskId || entry.taskId === filter.taskId),
  );
  if (!entries.length) return null;
  return {
    ...content,
    title:
      (filter.projectId || filter.taskId) && !filter.complete
        ? ""
        : content.title,
    entries: filter.complete ? content.entries : entries,
  };
}
