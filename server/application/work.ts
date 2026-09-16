import { DomainError } from "../domain/errors.ts";
import {
  archiveWork,
  assertTaskCreation,
  definitionSchema,
  reviseDefinition,
  type Definition,
  type ProjectState,
  type TaskState,
} from "../domain/work.ts";
import type { DateRange } from "../domain/diary.ts";
import type { Runtime, SharingRepository, WorkRepository } from "./ports.ts";
import type { Reading } from "./reading.ts";

export class Work {
  constructor(
    private readonly repo: WorkRepository,
    private readonly shares: SharingRepository,
    private readonly reading: Reading,
    private readonly runtime: Runtime,
  ) {}
  private project(id: string) {
    const p = this.repo.project(id);
    if (!p) throw new DomainError("not-found", "未找到项目。");
    return p;
  }
  private task(id: string) {
    const t = this.repo.task(id);
    if (!t) throw new DomainError("not-found", "未找到任务。");
    return t;
  }
  private view(p: ProjectState) {
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      creator: this.reading.member(p.createdBy),
      createdAt: p.createdAt,
      archived: p.archived,
    };
  }
  private taskView(t: TaskState) {
    return {
      ...this.view(t),
      projectId: t.projectId,
      status: t.status,
      version: t.version,
    };
  }
  projects() {
    return this.repo.projects().map((p) => this.view(p));
  }
  getProject(id: string) {
    return this.view(this.project(id));
  }
  getTask(id: string) {
    return this.taskView(this.task(id));
  }
  tasks(projectId: string) {
    this.project(projectId);
    return this.repo.tasks(projectId).map((t) => this.taskView(t));
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
    return this.view(p);
  }
  createTask(projectId: string, memberId: string, input: Definition) {
    return this.runtime.transaction(() => {
      assertTaskCreation(this.project(projectId));
      const t: TaskState = {
        ...definitionSchema.parse(input),
        id: this.runtime.id(),
        projectId,
        createdBy: memberId,
        createdAt: this.runtime.now(),
        archived: false,
        status: "pending",
        version: 1,
      };
      this.repo.saveTask(t);
      return this.taskView(t);
    });
  }
  reviseProject(id: string, memberId: string, input: Definition) {
    return this.runtime.transaction(() => {
      const p = reviseDefinition(this.project(id), memberId, input, "project");
      this.repo.saveProject(p);
      return this.view(p);
    });
  }
  reviseTask(id: string, memberId: string, input: Definition) {
    return this.runtime.transaction(() => {
      const t = reviseDefinition(this.task(id), memberId, input, "task");
      this.repo.saveTask(t);
      return this.taskView(t);
    });
  }
  archiveProject(id: string, memberId: string, archived: boolean) {
    return this.runtime.transaction(() => {
      const p = archiveWork(this.project(id), memberId, archived, "project");
      this.repo.saveProject(p);
      if (archived) this.shares.closeForProject(id, this.runtime.now());
      return this.view(p);
    });
  }
  archiveTask(id: string, memberId: string, archived: boolean) {
    return this.runtime.transaction(() => {
      const t = archiveWork(this.task(id), memberId, archived, "task");
      this.repo.saveTask(t);
      if (archived) this.shares.closeForTask(id, this.runtime.now());
      return this.taskView(t);
    });
  }
  projectProgress(id: string, range: DateRange) {
    this.project(id);
    return this.reading.published(range, { projectId: id });
  }
  taskProgress(id: string, range: DateRange) {
    this.task(id);
    return this.reading.published(range, { taskId: id });
  }
  events(id: string) {
    this.task(id);
    return this.repo
      .events(id)
      .map((e) => ({
        id: e.id,
        diaryId: e.diaryId,
        member: this.reading.member(e.memberId),
        before: e.before,
        after: e.after,
        at: e.at,
      }));
  }
}
