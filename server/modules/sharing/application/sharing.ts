import { dateRange, type DateRange } from "../../../shared/domain/date.ts";
import { DomainError } from "../../../shared/domain/errors.ts";
import {
  PublicShare,
  assertShareTarget,
  type ShareModule,
  type ShareState,
  type ShareType,
} from "../domain/sharing.ts";
import type { Runtime, Security } from "../../../shared/application/ports.ts";
import type { SharingRepository } from "./ports.ts";
import type { WorkRepository } from "../../work/application/ports.ts";
import type { Reading } from "../../journal/application/reading.ts";

export interface ShareInput extends DateRange {
  type: ShareType;
  targetId?: string;
  modules: ShareModule[];
}
export class Sharing {
  constructor(
    private readonly repo: SharingRepository,
    private readonly work: WorkRepository,
    private readonly reading: Reading,
    private readonly runtime: Runtime,
    private readonly security: Pick<Security, "secret">,
  ) {}
  available(token: string) {
    const state = this.repo.byToken(token);
    if (!state) throw new DomainError("gone", "此公开链接无效或已关闭。");
    const share = new PublicShare(state);
    share.assertAvailable();
    return share;
  }
  private target(type: ShareType, id: string | null, memberId: string) {
    if (type === "diary") return null;
    const selected = id
      ? type === "project"
        ? this.work.project(id, memberId)
        : this.work.task(id, memberId)
      : undefined;
    if (!selected) throw new DomainError("not-found", "未找到分享对象。");
    return selected;
  }
  private view(s: ShareState) {
    return {
      id: s.id,
      token: s.token,
      type: s.type,
      targetId: s.targetId,
      targetName:
        this.target(s.type, s.targetId, s.createdBy)?.name ?? "全团队日报",
      modules: s.modules,
      from: s.from,
      to: s.to,
      createdAt: s.createdAt,
      closed: s.closedAt !== null,
      path: `/share/${s.token}`,
    };
  }
  create(memberId: string, input: ShareInput) {
    return this.runtime.transaction(() => {
      dateRange({ ...input });
      if (input.type !== "diary" && !input.targetId)
        throw new DomainError("invalid", "请选择分享对象。");
      const selected = this.target(
        input.type,
        input.targetId ?? null,
        memberId,
      );
      assertShareTarget(
        input.type,
        selected,
        selected && "projectId" in selected
          ? this.work.project(String(selected.projectId), memberId)
          : undefined,
      );
      const state: ShareState = {
        ...input,
        id: this.runtime.id(),
        token: this.security.secret(),
        createdBy: memberId,
        targetId: input.type === "diary" ? null : input.targetId!,
        modules: [...new Set(input.modules)],
        createdAt: this.runtime.now(),
        closedAt: null,
      };
      this.repo.save(state);
      return this.view(state);
    });
  }
  mine(memberId: string) {
    return this.repo.mine(memberId).map((s) => this.view(s));
  }
  close(id: string, memberId: string) {
    this.runtime.transaction(() => {
      const state = this.repo.find(id);
      if (!state) throw new DomainError("not-found", "未找到分享。");
      this.reading.member(state.createdBy, memberId);
      const share = new PublicShare(state);
      share.close(memberId, this.runtime.now());
      this.repo.save(share.state);
    });
  }
  progress(share: PublicShare) {
    return this.reading.published(
      share.state.createdBy,
      share.state,
      share.progressFilter(),
    );
  }
  read(token: string) {
    const share = this.available(token),
      s = share.state,
      records = this.progress(share);
    const referenced = new Set(
      records.flatMap((r) =>
        r.published.entries.flatMap((e) => (e.taskId ? [e.taskId] : [])),
      ),
    );
    const tasks = this.work
      .tasks(s.createdBy)
      .filter((t) => share.includesTask(t, referenced));
    const selected = this.target(s.type, s.targetId, s.createdBy);
    return {
      type: s.type,
      from: s.from,
      to: s.to,
      modules: s.modules,
      ...(share.allows("overview")
        ? {
            overview: {
              name: selected?.name ?? "全团队日报",
              description:
                selected?.description ?? "所选日期内全团队成员的完整已提交日报",
              creator: selected
                ? this.reading.member(selected.createdBy, s.createdBy)
                : undefined,
              diaryCount: records.length,
              entryCount: records.reduce(
                (n, r) => n + r.published.entries.length,
                0,
              ),
              taskCount: tasks.length,
            },
          }
        : {}),
      ...(share.allows("progress") ? { progress: records } : {}),
      ...(share.allows("tasks")
        ? {
            tasks: tasks.map((t) => ({
              id: t.id,
              name: t.name,
              description: t.description,
              creator: this.reading.member(t.createdBy, s.createdBy),
              status: t.status,
              archived: t.archived,
            })),
          }
        : {}),
    };
  }
}
