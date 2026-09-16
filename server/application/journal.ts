import { Diary, contentSchema, type Content } from "../domain/diary.ts";
import { DomainError } from "../domain/errors.ts";
import {
  assertEntryAssociation,
  associateProject,
  associateTask,
  createTask,
  planTaskChanges,
  type TaskState,
} from "../domain/work.ts";
import type {
  AttachmentRepository,
  DiaryRepository,
  Runtime,
  WorkRepository,
} from "./ports.ts";
import type { Reading } from "./reading.ts";
import { normalizeAttachments } from "./attachment-references.ts";

export function ownedDiary(
  repo: DiaryRepository,
  id: string,
  memberId: string,
) {
  const state = repo.find(id);
  if (!state || state.authorId !== memberId)
    throw new DomainError("not-found", "未找到日报。");
  return new Diary(state);
}
export class Journal {
  constructor(
    private readonly repo: DiaryRepository,
    private readonly work: WorkRepository,
    private readonly attachments: AttachmentRepository,
    private readonly reading: Reading,
    private readonly runtime: Runtime,
  ) {}
  create(memberId: string, input: Content) {
    const diary = Diary.create(
      this.runtime.id(),
      memberId,
      input,
      this.runtime.now(),
    );
    normalizeAttachments(
      this.attachments,
      diary.state.draft,
      diary.state.id,
      memberId,
    );
    this.repo.save(diary.state);
    return diary.view(this.runtime.now());
  }
  mine(memberId: string) {
    return this.repo
      .mine(memberId)
      .map((s) => new Diary(s).view(this.runtime.now()));
  }
  get(id: string, memberId: string) {
    return ownedDiary(this.repo, id, memberId).view(this.runtime.now());
  }
  save(id: string, memberId: string, input: Content, version: unknown) {
    return this.runtime.transaction(() => {
      const diary = ownedDiary(this.repo, id, memberId),
        at = this.runtime.now();
      diary.assertWritable(at);
      diary.assertVersion(version);
      const content = contentSchema.parse(input);
      normalizeAttachments(this.attachments, content, id, memberId);
      diary.revise(content, version, at);
      this.repo.save(diary.state);
      return diary.view(at);
    });
  }
  delete(id: string, memberId: string, version: unknown) {
    this.runtime.transaction(() => {
      if (this.repo.deletion(id, memberId)) return;
      const diary = ownedDiary(this.repo, id, memberId),
        at = this.runtime.now();
      diary.assertWritable(at);
      diary.assertVersion(version);
      if (diary.state.published)
        this.repo.addDeletion({ diaryId: id, memberId, action: "delete", at });
      this.repo.remove(id);
    });
  }
  events() {
    return this.repo.deletions().map((e) => ({
      diaryId: e.diaryId,
      action: e.action,
      at: e.at,
      member: this.reading.member(e.memberId),
    }));
  }
  submit(
    id: string,
    memberId: string,
    input: { version: number; requestId: string },
  ) {
    return this.runtime.transaction(() => {
      const previous = this.repo.receipt(memberId, input.requestId);
      if (previous) {
        if (previous.diaryId !== id || previous.inputVersion !== input.version)
          throw new DomainError("conflict", "提交标识已使用，请重新提交。");
        return previous.result;
      }
      const diary = ownedDiary(this.repo, id, memberId),
        at = this.runtime.now();
      diary.assertWritable(at);
      diary.assertVersion(input.version);
      normalizeAttachments(this.attachments, diary.state.draft, id, memberId);
      const content = diary.submissionContent(at);
      const tasks = this.associateEntries(content, memberId, at);
      for (const change of planTaskChanges(content, tasks)) {
        this.work.saveTask(change.task);
        tasks.set(change.task.id, change.task);
        this.work.addEvent({
          id: this.runtime.id(),
          taskId: change.task.id,
          diaryId: id,
          memberId,
          before: change.before,
          after: change.task.status,
          at,
        });
      }
      for (const entry of content.entries) {
        if (entry.taskId) entry.taskStatus = tasks.get(entry.taskId)!.status;
        delete entry.statusChange;
      }
      diary.publish(content, at);
      this.repo.save(diary.state);
      const result = diary.view(at);
      this.repo.addReceipt({
        memberId,
        requestId: input.requestId,
        diaryId: id,
        inputVersion: input.version,
        result,
      });
      return result;
    });
  }
  private associateEntries(content: Content, memberId: string, at: number) {
    const tasks = new Map<string, TaskState>();
    for (const entry of content.entries) {
      delete entry.projectName;
      delete entry.taskName;
      delete entry.taskStatus;
      assertEntryAssociation(entry);
      if (!entry.projectId) continue;
      const project = this.work.project(entry.projectId);
      if (!project) throw new DomainError("not-found", "未找到项目。");
      associateProject(entry, project);
      if (entry.newTask) {
        const task = createTask(project, entry.newTask, {
          id: this.runtime.id(),
          createdBy: memberId,
          createdAt: at,
        });
        this.work.saveTask(task);
        entry.taskId = task.id;
        delete entry.newTask;
      }
      if (entry.taskId) {
        const task = this.work.task(entry.taskId);
        if (!task) throw new DomainError("not-found", "未找到任务。");
        associateTask(entry, task);
        tasks.set(task.id, task);
      }
    }
    return tasks;
  }
}
