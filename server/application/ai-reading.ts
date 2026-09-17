import { beijingDate, dateRange, type Content } from "../domain/diary.ts";
import { DomainError } from "../domain/errors.ts";
import type {
  PageInput,
  SearchInput,
  ProgressInput,
} from "../domain/ai-query.ts";
import type { Runtime, Security } from "./ports.ts";
import type { Reading } from "./reading.ts";
import type { Work } from "./work.ts";

export class AiReading {
  constructor(
    private readonly reading: Reading,
    private readonly work: Work,
    private readonly runtime: Runtime,
    private readonly security: Security,
  ) {}
  page<T>(items: T[], input: PageInput, binding: unknown) {
    const version = this.security.digest(JSON.stringify({ binding, items }));
    let offset = 0;
    if (input.cursor) {
      const parts = /^([a-f0-9]{64})\.(\d+)$/.exec(input.cursor);
      if (!parts) throw new DomainError("invalid", "分页游标不合法。");
      if (parts[1] !== version)
        throw new DomainError(
          "conflict",
          "读取内容或筛选已变化，请重新读取，不能拼接旧版本。",
        );
      offset = Number(parts[2]);
      if (!Number.isSafeInteger(offset) || offset > items.length)
        throw new DomainError("invalid", "分页位置不合法。");
    }
    const limit = input.limit;
    return {
      items: items.slice(offset, offset + limit),
      readVersion: version,
      nextCursor:
        offset + limit < items.length ? `${version}.${offset + limit}` : null,
      total: items.length,
    };
  }
  private sorted<T extends { id: string }>(items: T[]) {
    return items.sort((a, b) => a.id.localeCompare(b.id));
  }
  private search<T extends { id: string; name: string; archived?: boolean }>(
    items: T[],
    input: SearchInput,
  ) {
    return this.sorted(
      items.filter(
        (item) =>
          (!input.query ||
            item.name
              .toLocaleLowerCase()
              .includes(input.query.toLocaleLowerCase())) &&
          (input.archived === undefined || item.archived === input.archived),
      ),
    );
  }
  members(input: SearchInput) {
    return this.page(this.search(this.reading.members(), input), input, {
      tool: "members",
      query: input.query,
    });
  }
  projects(input: SearchInput) {
    return this.page(
      this.search(this.work.projects(), input).map((item) => ({
        ...item,
        description: [...item.description].slice(0, 160).join(""),
        truncated: [...item.description].length > 160,
        summary: true,
        detailTool: "get_project",
      })),
      input,
      { tool: "projects", query: input.query, archived: input.archived },
    );
  }
  project(id: string) {
    return this.work.getProject(id);
  }
  tasks(input: SearchInput & { projectId?: string }) {
    const items = input.projectId
      ? this.work.tasks(input.projectId)
      : this.work.projects().flatMap((project) => this.work.tasks(project.id));
    return this.page(
      this.search(items, input).map((item) => ({
        ...item,
        description: [...item.description].slice(0, 160).join(""),
        truncated: [...item.description].length > 160,
        summary: true,
        detailTool: "get_task",
      })),
      input,
      {
        tool: "tasks",
        query: input.query,
        projectId: input.projectId,
        archived: input.archived,
      },
    );
  }
  task(id: string) {
    return this.work.getTask(id);
  }
  events(input: PageInput & { id: string }) {
    return this.page(
      this.work
        .events(input.id)
        .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)),
      input,
      { tool: "events", id: input.id },
    );
  }
  diaries(input: ProgressInput, complete: boolean) {
    const today = beijingDate(this.runtime.now());
    const range = dateRange({
      from: input.from ?? today,
      to: input.to ?? today,
    });
    if (input.projectId) this.work.getProject(input.projectId);
    if (input.memberId) this.reading.member(input.memberId);
    if (input.taskId) {
      const task = this.work.getTask(input.taskId);
      if (input.projectId && task.projectId !== input.projectId)
        throw new DomainError("invalid", "任务不属于所选项目。");
    }
    const rows = this.sorted(
      this.reading.published(range, {
        projectId: input.projectId,
        taskId: input.taskId,
        memberId: input.memberId,
        complete,
      }),
    );
    const items = rows.map((row) => ({
      id: row.id,
      author: row.author,
      diaryDate: row.diaryDate,
      submittedAt: row.submittedAt,
      title: row.published.title,
      entryCount: row.published.entries.length,
      entryIds: row.published.entries.map((e) => e.id),
      excerpt: [...(row.published.entries[0]?.body ?? "")]
        .slice(0, 160)
        .join(""),
      truncated:
        row.published.entries.length > 1 ||
        [...(row.published.entries[0]?.body ?? "")].length > 160,
      summary: true,
      detailTool: "get_diary",
    }));
    return {
      ...this.page(items, input, {
        tool: complete ? "diaries" : "progress",
        range,
        projectId: input.projectId,
        taskId: input.taskId,
        memberId: input.memberId,
      }),
      range,
    };
  }
  diary(input: PageInput & { id: string }) {
    const row = this.reading.diary(input.id);
    return {
      id: row.id,
      author: row.author,
      diaryDate: row.diaryDate,
      submittedAt: row.submittedAt,
      title: row.published.title,
      ...this.contentPage(row.published, input, { tool: "diary", id: row.id }),
    };
  }
  contentPage(content: Content, input: PageInput, binding: unknown) {
    const segments = content.entries.flatMap((entry) => {
      const chars = [...entry.body],
        count = Math.max(1, Math.ceil(chars.length / 4000));
      return Array.from({ length: count }, (_, index) => ({
        entryId: entry.id,
        part: index + 1,
        parts: count,
        body: chars.slice(index * 4000, (index + 1) * 4000).join(""),
        projectId: entry.projectId,
        projectName: entry.projectName,
        taskId: entry.taskId,
        taskName: entry.taskName,
        taskStatusAtSubmission: entry.taskStatus,
        newTask: entry.newTask,
        statusChange: entry.statusChange,
        attachments: index === 0 ? (entry.attachments ?? []) : [],
      }));
    });
    return this.page(segments, input, { binding, title: content.title });
  }
}
