import { z } from "zod";
import { DomainError } from "../../../shared/domain/errors.ts";
import type { TaskStatus } from "./task-status.ts";
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
export function createTask(
  project: ProjectState,
  input: Definition,
  creation: Pick<TaskState, "id" | "createdBy" | "createdAt">,
): TaskState {
  assertTaskCreation(project);
  return {
    ...definitionSchema.parse(input),
    ...creation,
    projectId: project.id,
    archived: false,
    status: "pending",
    version: 1,
  };
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
      : "只有创建者可修改任务名称和说明。",
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
  if (project.archived) throw new DomainError("archived", "项目已归档。");
}
export function changeTaskStatus(
  task: TaskState,
  project: ProjectState,
  status: TaskStatus,
  expectedVersion: number,
) {
  assertTaskCreation(project);
  if (task.archived) throw new DomainError("archived", "任务已归档。");
  if (task.version !== expectedVersion)
    throw new DomainError(
      "version-conflict",
      "任务状态已被更新，请读取最新版本并等待成员处理指令。",
      {
        taskId: task.id,
        latestVersion: task.version,
        latestStatus: task.status,
        requestedStatus: status,
      },
    );
  return task.status === status
    ? task
    : { ...task, status, version: task.version + 1 };
}
