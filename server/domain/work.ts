import { z } from "zod";
import { DomainError } from "./errors.ts";
import type { Content, TaskStatus, WorkEntry } from "./diary.ts";
export const definitionSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(10_000),
});
export type Definition = z.infer<typeof definitionSchema>;
export interface ProjectState extends Definition {
  id: string;
  createdBy: string;
  createdAt: number;
  archived: boolean;
}
export interface TaskState extends ProjectState {
  projectId: string;
  status: TaskStatus;
  version: number;
}
export function assertCreator(
  record: ProjectState,
  memberId: string,
  message: string,
) {
  if (record.createdBy !== memberId)
    throw new DomainError("forbidden", message);
}
export function reviseDefinition<T extends ProjectState>(
  record: T,
  memberId: string,
  input: Definition,
  kind: "project" | "task",
): T {
  assertCreator(
    record,
    memberId,
    kind === "project"
      ? "只有创建者可修改项目资料。"
      : "只有创建者可修改任务定义。",
  );
  return { ...record, ...definitionSchema.parse(input) };
}
export function archiveWork<T extends ProjectState>(
  record: T,
  memberId: string,
  archived: boolean,
  kind: "project" | "task",
): T {
  assertCreator(
    record,
    memberId,
    kind === "project"
      ? "只有创建者可以归档或恢复项目。"
      : "只有创建者可以归档或恢复任务。",
  );
  return { ...record, archived };
}
export function assertTaskCreation(project: ProjectState) {
  if (project.archived) throw new DomainError("conflict", "项目已归档。");
}
export function assertEntryAssociation(entry: WorkEntry) {
  if ((entry.taskId || entry.newTask) && !entry.projectId)
    throw new DomainError("invalid", "请先为任务选择项目。");
  if (entry.taskId && entry.newTask)
    throw new DomainError("invalid", "已有任务和新任务只能选择一个。");
}
export function associateProject(entry: WorkEntry, project: ProjectState) {
  if (project.archived)
    throw new DomainError("conflict", "项目已归档，请调整工作条目关联。");
  entry.projectName = project.name;
}
export function associateTask(entry: WorkEntry, task: TaskState) {
  if (task.projectId !== entry.projectId)
    throw new DomainError("invalid", "任务必须属于当前条目的项目。");
  if (task.archived) throw new DomainError("conflict", "任务已归档。");
  entry.taskName = task.name;
  entry.taskStatus = task.status;
}
export function planTaskChanges(
  content: Content,
  tasks: ReadonlyMap<string, TaskState>,
) {
  const changes = new Map<string, NonNullable<WorkEntry["statusChange"]>>();
  const mixed = new Set<string>();
  for (const entry of content.entries) {
    if (!entry.statusChange) continue;
    if (!entry.taskId)
      throw new DomainError("invalid", "状态更新必须关联任务。");
    const previous = changes.get(entry.taskId);
    if (previous && previous.status !== entry.statusChange.status)
      throw new DomainError(
        "invalid",
        "同一任务的状态选择不一致，请统一后再提交。",
      );
    if (
      previous &&
      (previous.expectedVersion !== entry.statusChange.expectedVersion ||
        previous.resolution !== entry.statusChange.resolution)
    )
      mixed.add(entry.taskId);
    changes.set(entry.taskId, entry.statusChange);
  }
  const conflicts = [...changes].flatMap(([id, change]) => {
    const task = tasks.get(id)!;
    return task.version === change.expectedVersion && !mixed.has(id)
      ? []
      : [
          {
            taskId: id,
            taskName: task.name,
            latestVersion: task.version,
            latestStatus: task.status,
            requestedStatus: change.status,
          },
        ];
  });
  if (conflicts.length)
    throw new DomainError(
      "conflict",
      "任务状态已被更新，请选择如何处理后重新提交。",
      { conflicts },
    );
  return [...changes].flatMap(([id, change]) => {
    const task = tasks.get(id)!;
    return change.resolution === "keep" || task.status === change.status
      ? []
      : [
          {
            before: task.status,
            task: { ...task, status: change.status, version: task.version + 1 },
          },
        ];
  });
}
