import { DomainError } from "../domain/errors.ts";
import {
  projectPublishedContent,
  type Content,
  type DateRange,
  type DiaryState,
  type ProgressFilter,
} from "../domain/diary.ts";
import type { DiaryRepository, MembershipRepository } from "./ports.ts";

/** Shared read model. Only explicitly published content and public member identities leave this boundary. */
export class Reading {
  constructor(
    private readonly diaries: DiaryRepository,
    private readonly membership: MembershipRepository,
  ) {}
  member(id: string) {
    const member = this.membership.member(id);
    if (!member) throw new DomainError("not-found", "未找到成员。");
    return { id: member.id, name: member.name };
  }
  members() {
    return this.membership.members();
  }
  private view(row: DiaryState, content: Content) {
    return {
      id: row.id,
      author: this.member(row.authorId),
      diaryDate: row.diaryDate,
      submittedAt: row.submittedAt,
      firstSubmittedAt: row.firstSubmittedAt,
      published: content,
    };
  }
  diary(id: string) {
    const row = this.diaries.find(id);
    if (!row?.published)
      throw new DomainError("not-found", "未找到已提交日报。");
    return this.view(row, row.published);
  }
  published(range: DateRange, filter: ProgressFilter = {}) {
    return this.diaries.published(range).flatMap((row) => {
      if (
        !row.published ||
        (filter.memberId && row.authorId !== filter.memberId)
      )
        return [];
      const content = projectPublishedContent(row.published, filter);
      return content ? [this.view(row, content)] : [];
    });
  }
}
