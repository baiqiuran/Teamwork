import { z } from "zod";
import { taskStatusSchema } from "../../../work/domain/task-status.ts";
import { capabilities } from "../../domain/ai-authorization.ts";
const member = z.object({ id: z.uuid(), name: z.string() });
const project = z
  .object({
    id: z.uuid(),
    name: z.string(),
    description: z.string(),
    archived: z.boolean(),
    creator: member,
    createdAt: z.number(),
  })
  .passthrough();
const task = project.extend({
  projectId: z.uuid(),
  status: taskStatusSchema,
  version: z.number().int().positive(),
});
const page = (item: z.ZodType) =>
  z
    .object({
      items: z.array(item),
      nextCursor: z.string().nullable(),
      readVersion: z.string(),
      total: z.number().int().nonnegative(),
    })
    .passthrough();
const entry = z
  .object({
    entryId: z.uuid(),
    part: z.number().int().positive(),
    parts: z.number().int().positive(),
    body: z.string(),
    attachments: z.array(
      z
        .object({ id: z.uuid(), name: z.string(), size: z.number() })
        .passthrough(),
    ),
  })
  .passthrough();
const draft = z
  .object({
    id: z.uuid(),
    version: z.number().int().positive(),
    title: z.string(),
    editable: z.boolean(),
  })
  .passthrough();
const share = z
  .object({
    id: z.uuid(),
    type: z.enum(["diary", "project", "task"]),
    targetId: z.uuid().nullable(),
    from: z.iso.date(),
    to: z.iso.date(),
    modules: z.array(z.enum(["overview", "tasks", "progress"])),
    url: z.url(),
    closed: z.boolean(),
  })
  .passthrough();
const receipt = z.object({
  objectId: z.uuid(),
  executedAt: z.number(),
  replayed: z.boolean(),
});
const diaryReceipt = receipt.extend({ diary: draft, webPath: z.string() });
export const outputSchemas: Record<string, z.ZodType> = {
  get_context: z.object({
    member,
    scopes: z.array(z.enum(capabilities)),
    time: z.iso.datetime(),
    date: z.iso.date(),
    timeZone: z.literal("Asia/Shanghai"),
    limits: z.record(z.string(), z.union([z.string(), z.number()])),
  }),
  list_members: page(member),
  list_projects: page(project),
  get_project: project,
  list_tasks: page(task),
  get_task: task,
  list_task_events: page(
    z
      .object({
        id: z.uuid(),
        member,
        at: z.number(),
        before: taskStatusSchema,
        after: taskStatusSchema,
        diaryId: z.uuid().nullable(),
        kind: z.enum(["diary", "direct"]),
        channel: z.enum(["web", "mcp"]),
      })
      .passthrough(),
  ),
  list_diaries: page(
    z
      .object({
        id: z.uuid(),
        author: member,
        diaryDate: z.iso.date(),
        title: z.string(),
        summary: z.literal(true),
        entryIds: z.array(z.uuid()),
      })
      .passthrough(),
  ),
  query_progress: page(
    z
      .object({
        id: z.uuid(),
        author: member,
        diaryDate: z.iso.date(),
        entryIds: z.array(z.uuid()),
        summary: z.literal(true),
      })
      .passthrough(),
  ),
  get_diary: page(entry).extend({
    id: z.uuid(),
    author: member,
    diaryDate: z.iso.date(),
    title: z.string(),
  }),
  list_my_drafts: page(draft),
  get_my_draft: page(entry).extend({
    id: z.uuid(),
    title: z.string(),
    version: z.number().int().positive(),
    editable: z.boolean(),
    submitted: z.boolean(),
  }),
  create_draft: diaryReceipt,
  update_draft: diaryReceipt,
  submit_diary: diaryReceipt.extend({
    taskEffects: z.array(
      z.object({
        taskId: z.uuid(),
        projectId: z.uuid(),
        name: z.string(),
        created: z.boolean(),
        beforeStatus: taskStatusSchema.nullable(),
        afterStatus: taskStatusSchema,
        version: z.number().int().positive(),
      }),
    ),
    publicImpact: z.object({
      published: z.literal(true),
      diaryDate: z.iso.date(),
      projectIds: z.array(z.uuid()),
      message: z.string(),
    }),
  }),
  create_task: receipt.extend({ task }),
  update_task_status: receipt.extend({
    task,
    changed: z.boolean(),
    beforeStatus: taskStatusSchema,
    afterStatus: taskStatusSchema,
  }),
  list_my_shares: page(share),
  create_share: receipt.extend({ share, publicScope: z.string() }),
  close_share: receipt.extend({ closed: z.literal(true) }),
};
