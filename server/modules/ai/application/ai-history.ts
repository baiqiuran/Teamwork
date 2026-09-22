import type { AiOperation } from "../domain/ai-operation.ts";
import type { PageInput } from "./query-contracts.ts";
import { DomainError } from "../../../shared/domain/errors.ts";
import type { AiOperationRepository } from "./ports.ts";
import type { AiReading } from "./ai-reading.ts";
import type { Journal } from "../../journal/application/journal.ts";
import type { Work } from "../../work/application/work.ts";
import type { Sharing } from "../../sharing/application/sharing.ts";
export class AiHistory {
  constructor(
    private readonly repo: AiOperationRepository,
    private readonly reading: AiReading,
    private readonly journal: Journal,
    private readonly work: Work,
    private readonly sharing: Sharing,
  ) {}
  private object(
    event: AiOperation,
    memberId: string,
  ): { state: string; url?: string } {
    if (!event.objectId) return { state: "未产生可跳转对象" };
    try {
      if (
        ["create_draft", "update_draft", "submit_diary"].includes(event.tool)
      ) {
        const diary = this.journal.get(event.objectId, memberId);
        return {
          state: diary.editable ? "可编辑" : "历史已锁定",
          url: `/diaries?diary=${diary.id}`,
        };
      }
      if (["create_task", "update_task_status"].includes(event.tool)) {
        const task = this.work.getTask(event.objectId, memberId);
        return {
          state:
            task.archived ||
            this.work.getProject(task.projectId, memberId).archived
              ? "已归档"
              : "当前任务",
          url: `/projects?project=${task.projectId}&task=${task.id}`,
        };
      }
      const share = this.sharing
        .mine(memberId)
        .find((s) => s.id === event.objectId);
      return share
        ? { state: share.closed ? "链接已关闭" : "链接开放中", url: "/sharing" }
        : { state: "对象已不可用" };
    } catch (error) {
      if (error instanceof DomainError)
        return { state: "对象已删除或不可访问" };
      throw error;
    }
  }
  list(
    memberId: string,
    input: PageInput & { outcome?: AiOperation["outcome"] },
  ) {
    const page = this.reading.page(
      this.repo
        .operations(memberId)
        .filter((event) => !input.outcome || event.outcome === input.outcome),
      input,
      { tool: "operations", memberId, outcome: input.outcome },
    );
    return {
      ...page,
      items: page.items.map((event) => ({
        ...event,
        object: this.object(event, memberId),
      })),
    };
  }
}
