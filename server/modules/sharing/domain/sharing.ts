import { DomainError } from "../../../shared/domain/errors.ts";
import type { DateRange } from "../../../shared/domain/date.ts";
import type { ProgressFilter } from "../../journal/domain/diary.ts";
export type ShareType = "diary" | "project" | "task";
export type ShareModule = "overview" | "tasks" | "progress";
export interface ShareState extends DateRange {
  id: string;
  token: string;
  createdBy: string;
  type: ShareType;
  targetId: string | null;
  modules: ShareModule[];
  createdAt: number;
  closedAt: number | null;
}
export class PublicShare {
  constructor(readonly state: ShareState) {}
  assertAvailable() {
    if (this.state.closedAt !== null)
      throw new DomainError("share-closed", "此公开链接无效或已关闭。");
  }
  close(memberId: string, now: number) {
    if (this.state.createdBy !== memberId)
      throw new DomainError("forbidden", "只有生成者可以关闭链接。");
    this.state.closedAt ??= now;
  }
  allows(module: ShareModule) {
    return this.state.modules.includes(module);
  }
  progressFilter(): ProgressFilter {
    return {
      projectId:
        this.state.type === "project" ? this.state.targetId! : undefined,
      taskId: this.state.type === "task" ? this.state.targetId! : undefined,
    };
  }
  includesTask(
    task: { id: string; projectId: string },
    referenced: ReadonlySet<string>,
  ) {
    return this.state.type === "project"
      ? task.projectId === this.state.targetId
      : this.state.type === "task"
        ? task.id === this.state.targetId
        : referenced.has(task.id);
  }
}
export function assertShareTarget(
  type: ShareType,
  target: { archived: boolean } | null,
  parent?: { archived: boolean },
) {
  if (type !== "diary" && !target)
    throw new DomainError("invalid", "请选择分享对象。");
  if (target?.archived || parent?.archived)
    throw new DomainError("archived", "归档对象不能生成公开链接。");
}
