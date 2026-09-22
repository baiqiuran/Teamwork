import { DomainError } from "../../../shared/domain/errors.ts";
import {
  archiveWork,
  createTask,
  changeTaskStatus,
  definitionSchema,
  reviseDefinition,
  type Definition,
  type ProjectState,
  type TaskState,
} from "../domain/work.ts";
import type { DateRange } from "../../../shared/domain/date.ts";
import type { TaskStatus } from "../domain/task-status.ts";
import type { Runtime } from "../../../shared/application/ports.ts";
import type { SharingRepository } from "../../sharing/application/ports.ts";
import type { WorkRepository } from "./ports.ts";
import type { Reading } from "../../journal/application/reading.ts";

export class Work {
  constructor(
    private readonly repo: WorkRepository,
    private readonly shares: SharingRepository,
    private readonly reading: Reading,
    private readonly runtime: Runtime,
  ) {}
  private project(id: string, memberId: string) {
    const p = this.repo.project(id, memberId);
    if (!p) throw new DomainError("not-found", "未找到项目。");
    return p;
  }
  private task(id: string, memberId: string) {
    const t = this.repo.task(id, memberId);
    if (!t) throw new DomainError("not-found", "未找到任务。");
    return t;
  }
  private view(p: ProjectState, memberId: string) {
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      creator: this.reading.member(p.createdBy, memberId),
      createdAt: p.createdAt,
      archived: p.archived,
    };
  }
  private taskView(t: TaskState, memberId: string) {
    return {
      ...this.view(t, memberId),
      projectId: t.projectId,
      status: t.status,
      version: t.version,
    };
  }
  projects(memberId: string) {
    return this.repo.projects(memberId).map((p) => this.view(p, memberId));
  }
  getProject(id: string, memberId: string) {
    return this.view(this.project(id, memberId), memberId);
  }
  getTask(id: string, memberId: string) {
    return this.taskView(this.task(id, memberId), memberId);
  }
  tasks(projectId: string, memberId: string) {
    this.project(projectId, memberId);
    return this.repo
      .tasks(memberId, projectId)
      .map((t) => this.taskView(t, memberId));
  }
  createProject(memberId: string, input: Definition) {
    const p: ProjectState = {
      ...definitionSchema.parse(input),
      id: this.runtime.id(),
      createdBy: memberId,
      createdAt: this.runtime.now(),
      archived: false,
    };
    this.repo.saveProject(p);
    return this.view(p, memberId);
  }
  createTask(projectId: string, memberId: string, input: Definition) {
    return this.runtime.transaction(() => {
      const t = createTask(this.project(projectId, memberId), input, {
        id: this.runtime.id(),
        createdBy: memberId,
        createdAt: this.runtime.now(),
      });
      this.repo.saveTask(t);
      return this.taskView(t, memberId);
    });
  }
  reviseProject(id: string, memberId: string, input: Definition) {
    return this.runtime.transaction(() => {
      const p = reviseDefinition(
        this.project(id, memberId),
        memberId,
        input,
        "project",
      );
      this.repo.saveProject(p);
      return this.view(p, memberId);
    });
  }
  updateStatus(
    id: string,
    memberId: string,
    status: TaskStatus,
    expectedVersion: number,
    channel: "web" | "mcp",
  ) {
    return this.runtime.transaction(() => {
      const current = this.task(id, memberId),
        task = changeTaskStatus(
          current,
          this.project(current.projectId, memberId),
          status,
          expectedVersion,
        );
      const changed = task !== current;
      if (changed) {
        this.repo.saveTask(task);
        this.repo.addEvent({
          id: this.runtime.id(),
          taskId: id,
          diaryId: null,
          kind: "direct",
          channel,
          memberId,
          before: current.status,
          after: task.status,
          at: this.runtime.now(),
        });
      }
      return {
        task: this.taskView(task, memberId),
        changed,
        beforeStatus: current.status,
        afterStatus: task.status,
      };
    });
  }
  reviseTask(id: string, memberId: string, input: Definition) {
    return this.runtime.transaction(() => {
      const t = reviseDefinition(
        this.task(id, memberId),
        memberId,
        input,
        "task",
      );
      this.repo.saveTask(t);
      return this.taskView(t, memberId);
    });
  }
  archiveProject(id: string, memberId: string, archived: boolean) {
    return this.runtime.transaction(() => {
      const p = archiveWork(
        this.project(id, memberId),
        memberId,
        archived,
        "project",
      );
      this.repo.saveProject(p);
      if (archived) this.shares.closeForProject(id, this.runtime.now());
      return this.view(p, memberId);
    });
  }
  archiveTask(id: string, memberId: string, archived: boolean) {
    return this.runtime.transaction(() => {
      const t = archiveWork(
        this.task(id, memberId),
        memberId,
        archived,
        "task",
      );
      this.repo.saveTask(t);
      if (archived) this.shares.closeForTask(id, this.runtime.now());
      return this.taskView(t, memberId);
    });
  }
  projectProgress(id: string, memberId: string, range: DateRange) {
    this.project(id, memberId);
    return this.reading.published(memberId, range, { projectId: id });
  }
  taskProgress(id: string, memberId: string, range: DateRange) {
    this.task(id, memberId);
    return this.reading.published(memberId, range, { taskId: id });
  }
  events(id: string, memberId: string) {
    this.task(id, memberId);
    return this.repo.events(id, memberId).map((e) => ({
      id: e.id,
      diaryId: e.diaryId,
      kind: e.kind,
      channel: e.channel,
      member: this.reading.member(e.memberId, memberId),
      before: e.before,
      after: e.after,
      at: e.at,
    }));
  }
}
