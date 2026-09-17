import { z } from "zod";
import { taskStatusSchema } from "../../work/domain/task-status.ts";
export const operationInput = z.object({
  operationId: z.string().min(1).max(128),
});
const text = (max: number) =>
  z.string().refine((value) => [...value].length <= max, `最多 ${max} 字`);
export const aiEntry = z
  .object({
    id: z.uuid(),
    body: text(10000),
    projectId: z.uuid().optional(),
    taskId: z.uuid().optional(),
    newTask: z
      .object({
        name: z.string().trim().min(1).max(100),
        description: text(10000),
      })
      .strict()
      .optional(),
    statusChange: z
      .object({
        status: taskStatusSchema,
        expectedVersion: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const createDraftInput = operationInput
  .extend({ title: text(100), entries: z.array(aiEntry).max(50) })
  .strict()
  .refine(
    (input) =>
      new Set(input.entries.map((e) => e.id)).size === input.entries.length,
    "条目标识不能重复",
  );
export type CreateDraftInput = z.infer<typeof createDraftInput>;
const entryChanges = z
  .object({
    body: text(10000).optional(),
    projectId: z.uuid().nullable().optional(),
    taskId: z.uuid().nullable().optional(),
    newTask: aiEntry.shape.newTask.unwrap().nullable().optional(),
    statusChange: aiEntry.shape.statusChange.unwrap().nullable().optional(),
  })
  .strict();
export const updateDraftInput = operationInput
  .extend({
    id: z.uuid(),
    expectedVersion: z.number().int().positive(),
    title: text(100).optional(),
    changes: z
      .array(
        z.discriminatedUnion("op", [
          z.object({ op: z.literal("add"), entry: aiEntry }).strict(),
          z
            .object({
              op: z.literal("update"),
              id: z.uuid(),
              fields: entryChanges,
            })
            .strict(),
          z.object({ op: z.literal("remove"), id: z.uuid() }).strict(),
        ]),
      )
      .max(50),
  })
  .strict();
export type UpdateDraftInput = z.infer<typeof updateDraftInput>;
export const createTaskInput = operationInput
  .extend({
    projectId: z.uuid(),
    name: z.string().trim().min(1).max(100),
    description: text(10000),
  })
  .strict();
export const updateTaskInput = operationInput
  .extend({
    id: z.uuid(),
    status: taskStatusSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type CreateTaskInput = z.infer<typeof createTaskInput>;
export type UpdateTaskInput = z.infer<typeof updateTaskInput>;
export const submitDiaryInput = operationInput
  .extend({ id: z.uuid(), expectedVersion: z.number().int().positive() })
  .strict();
export type SubmitDiaryInput = z.infer<typeof submitDiaryInput>;
const shareRange = {
  from: z.iso.date(),
  to: z.iso.date(),
  modules: z
    .array(z.enum(["overview", "tasks", "progress"]))
    .min(1)
    .max(3)
    .transform((values) => [...new Set(values)].sort()),
};
export const createShareInput = z.discriminatedUnion("type", [
  operationInput.extend({ ...shareRange, type: z.literal("diary") }).strict(),
  operationInput
    .extend({
      ...shareRange,
      type: z.enum(["project", "task"]),
      targetId: z.uuid(),
    })
    .strict(),
]);
export const closeShareInput = operationInput.extend({ id: z.uuid() }).strict();
export type CreateShareInput = z.infer<typeof createShareInput>;
export type CloseShareInput = z.infer<typeof closeShareInput>;
