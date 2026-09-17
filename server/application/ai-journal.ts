import {
  type CreateDraftInput,
  type UpdateDraftInput,
  type SubmitDiaryInput,
} from "../domain/ai-operation.ts";
import {
  assertEntryAssociation,
  assertProjectAssociation,
  assertTaskAssociation,
} from "../domain/work.ts";
import { Diary, type Content } from "../domain/diary.ts";
import { DomainError } from "../domain/errors.ts";
import type { PageInput } from "../domain/ai-query.ts";
import type { Journal } from "./journal.ts";
import type { Work } from "./work.ts";
import type { AiReading } from "./ai-reading.ts";
import type { AiOperations, AiAccess } from "./ai-operations.ts";
import type { AiAuthorization } from "./ai-authorization.ts";

export class AiJournal {
  constructor(
    private readonly journal: Journal,
    private readonly work: Work,
    private readonly operations: AiOperations,
    private readonly auth: AiAuthorization,
    private readonly reading: AiReading,
  ) {}
  private summary(diary: ReturnType<Journal["get"]>) {
    return {
      id: diary.id,
      version: diary.version,
      title: diary.draft.title,
      editable: diary.editable,
      diaryDate: diary.diaryDate,
      submittedAt: diary.submittedAt,
      entryCount: diary.draft.entries.length,
      summary: true,
      detailTool: "get_my_draft",
    };
  }
  private associations(content: Content) {
    for (const entry of content.entries) {
      assertEntryAssociation(entry);
      if (entry.statusChange && !entry.taskId)
        throw new DomainError("invalid", "状态意图必须关联现有任务。");
      if (!entry.projectId) continue;
      const project = this.work.getProject(entry.projectId);
      assertProjectAssociation(project);
      if (entry.taskId) {
        const task = this.work.getTask(entry.taskId);
        assertTaskAssociation(entry, task);
      }
    }
  }
  create(access: AiAccess, input: CreateDraftInput) {
    return this.operations.run(
      access,
      "create_draft",
      input,
      ["drafts:write"],
      (memberId) => {
        this.associations(input);
        const diary = this.journal.create(memberId, input);
        return {
          result: { diary: this.summary(diary), webPath: "/diaries" },
          objectId: diary.id,
        };
      },
    );
  }
  submit(access: AiAccess, input: SubmitDiaryInput) {
    return this.operations.run(
      access,
      "submit_diary",
      input,
      ["diaries:submit"],
      (memberId) => {
        const before = this.journal.get(input.id, memberId).draft;
        const priorTasks = new Map(
          before.entries
            .filter((e) => e.taskId)
            .map((e) => [e.taskId!, this.work.getTask(e.taskId!)]),
        );
        const diary = this.journal.submit(
          input.id,
          memberId,
          {
            version: input.expectedVersion,
            requestId: `mcp:${input.operationId}`,
          },
          "mcp",
        );
        const createdIds = new Set(
          before.entries.filter((e) => e.newTask).map((e) => e.id),
        );
        const taskEffects = [
          ...new Set(
            diary.published!.entries.flatMap((e) =>
              e.taskId ? [e.taskId] : [],
            ),
          ),
        ].flatMap((id) => {
          const task = this.work.getTask(id),
            prior = priorTasks.get(id);
          const created = diary.published!.entries.some(
            (e) => e.taskId === id && createdIds.has(e.id),
          );
          return created || prior?.status !== task.status
            ? [
                {
                  taskId: id,
                  projectId: task.projectId,
                  name: task.name,
                  created,
                  beforeStatus: prior?.status ?? null,
                  afterStatus: task.status,
                  version: task.version,
                },
              ]
            : [];
        });
        return {
          result: {
            diary: this.summary(diary),
            webPath: "/diaries",
            taskEffects,
            publicImpact: {
              published: true,
              diaryDate: diary.diaryDate,
              projectIds: [
                ...new Set(
                  diary.published!.entries.flatMap((e) =>
                    e.projectId ? [e.projectId] : [],
                  ),
                ),
              ],
              message:
                "团队和项目归集已更新；覆盖该日期与对象的既有公开进展随提交更新，开放的任务模块读取当前任务状态。",
            },
          },
          objectId: diary.id,
        };
      },
      (memberId) =>
        this.journal
          .get(input.id, memberId)
          .draft.entries.some((entry) => entry.newTask || entry.statusChange)
          ? ["tasks:write"]
          : [],
    );
  }
  update(access: AiAccess, input: UpdateDraftInput) {
    return this.operations.run(
      access,
      "update_draft",
      input,
      ["drafts:write"],
      (memberId) => {
        const existing = this.journal.get(input.id, memberId),
          content = structuredClone(existing.draft),
          touched = new Set<string>();
        try {
          new Diary(existing).assertVersion(input.expectedVersion);
        } catch (error) {
          if (error instanceof DomainError)
            throw new DomainError(error.code, error.message, {
              diaryId: existing.id,
              latestVersion: existing.version,
              current: {
                title: existing.draft.title,
                entryCount: existing.draft.entries.length,
                editable: existing.editable,
              },
              requested: {
                expectedVersion: input.expectedVersion,
                title: input.title,
                changes: input.changes.map((change) => ({
                  op: change.op,
                  id: change.op === "add" ? change.entry.id : change.id,
                })),
              },
              detailTool: "get_my_draft",
            });
          throw error;
        }
        if (input.title !== undefined) content.title = input.title;
        for (const change of input.changes) {
          const id = change.op === "add" ? change.entry.id : change.id;
          if (touched.has(id))
            throw new DomainError("invalid", "一次操作不能重复修改同一条目。");
          touched.add(id);
          const index = content.entries.findIndex((e) => e.id === id);
          if (change.op === "add") {
            if (index !== -1)
              throw new DomainError("invalid", "条目标识已存在。");
            content.entries.push(change.entry);
            continue;
          }
          if (index === -1)
            throw new DomainError("not-found", "未找到指定工作条目。");
          if (change.op === "remove") {
            if (content.entries[index].attachments?.length)
              throw new DomainError("invalid", "含附件条目只能在网页删除。", {
                webPath: `/diaries?diary=${existing.id}`,
              });
            content.entries.splice(index, 1);
            continue;
          }
          content.entries[index] = {
            ...content.entries[index],
            ...change.fields,
            projectId:
              change.fields.projectId === null
                ? undefined
                : (change.fields.projectId ?? content.entries[index].projectId),
            taskId:
              change.fields.taskId === null
                ? undefined
                : (change.fields.taskId ?? content.entries[index].taskId),
            newTask:
              change.fields.newTask === null
                ? undefined
                : (change.fields.newTask ?? content.entries[index].newTask),
            statusChange:
              change.fields.statusChange === null
                ? undefined
                : (change.fields.statusChange ??
                  content.entries[index].statusChange),
          };
        }
        this.associations(content);
        const diary = this.journal.save(
          input.id,
          memberId,
          content,
          input.expectedVersion,
        );
        return {
          result: { diary: this.summary(diary), webPath: "/diaries" },
          objectId: diary.id,
        };
      },
    );
  }
  list(access: AiAccess, input: PageInput) {
    return this.auth.authorized(
      access.token,
      access.resource,
      ["drafts:write"],
      ({ member }) =>
        this.reading.page(
          this.journal
            .mine(member.id)
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((diary) => ({
              id: diary.id,
              title: diary.draft.title,
              version: diary.version,
              editable: diary.editable,
              submitted: !!diary.published,
              pendingChanges:
                JSON.stringify(diary.draft) !== JSON.stringify(diary.published),
              entryCount: diary.draft.entries.length,
              summary: true,
              detailTool: "get_my_draft",
            })),
          input,
          { tool: "my-drafts", memberId: member.id },
        ),
    );
  }
  get(access: AiAccess, input: PageInput & { id: string }) {
    return this.auth.authorized(
      access.token,
      access.resource,
      ["drafts:write"],
      ({ member }) => {
        const diary = this.journal.get(input.id, member.id);
        return {
          id: diary.id,
          title: diary.draft.title,
          version: diary.version,
          editable: diary.editable,
          submitted: !!diary.published,
          ...this.reading.contentPage(diary.draft, input, {
            tool: "my-draft",
            id: diary.id,
            version: diary.version,
          }),
        };
      },
    );
  }
}
