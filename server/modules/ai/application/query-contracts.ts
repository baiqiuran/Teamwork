import { z } from "zod";
import { taskStatusSchema } from "../../work/domain/task-status.ts";
export const pageInput = z.object({
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});
export const searchInput = pageInput
  .extend({
    query: z.string().max(100).optional(),
    archived: z.boolean().optional(),
  })
  .strict();
export const taskListInput = searchInput
  .extend({
    projectId: z.uuid().optional(),
    status: taskStatusSchema.optional(),
  })
  .strict();
export const idInput = z.object({ id: z.uuid() }).strict();
export const detailInput = pageInput.extend({ id: z.uuid() }).strict();
export const progressInput = pageInput
  .extend({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    projectId: z.uuid().optional(),
    taskId: z.uuid().optional(),
    memberId: z.uuid().optional(),
  })
  .strict();
export type PageInput = z.infer<typeof pageInput>;
export type SearchInput = z.infer<typeof searchInput>;
export type ProgressInput = z.infer<typeof progressInput>;
export const shareListInput = pageInput
  .extend({ closed: z.boolean().optional() })
  .strict();
