import { DomainError } from "../../../shared/domain/errors.ts";
import {
  projectPublishedContent,
  type Content,
  type DiaryState,
  type ProgressFilter,
} from "../domain/diary.ts";
import { type DateRange } from "../../../shared/domain/date.ts";
import type { DiaryRepository } from "./ports.ts";
import type { MembershipRepository } from "../../membership/application/ports.ts";

export class Reading {
  constructor(
    private readonly diaries: DiaryRepository,
    private readonly membership: MembershipRepository,
  ) {}
  member(id: string, scopeMemberId: string) {
    const member = this.membership.member(id);
    const scope = this.membership.member(scopeMemberId);
    if (!member || !scope || member.teamId !== scope.teamId)
      throw new DomainError("not-found", "未找到成员。");
    return { id: member.id, name: member.name };
  }
  members(scopeMemberId: string) {
    const latest = new Map(
      this.diaries
        .latestSubmitted(scopeMemberId)
        .map((row) => [row.memberId, row.diaryDate]),
    );
    return this.membership.members(scopeMemberId).map((member) => ({
      ...member,
      lastDiaryDate: latest.get(member.id) ?? null,
    }));
  }
  private view(row: DiaryState, content: Content, scopeMemberId: string) {
    return {
      id: row.id,
      author: this.member(row.authorId, scopeMemberId),
      diaryDate: row.diaryDate,
      submittedAt: row.submittedAt,
      firstSubmittedAt: row.firstSubmittedAt,
      published: content,
    };
  }
  diary(id: string, scopeMemberId: string) {
    const row = this.diaries.find(id);
    if (!row?.published)
      throw new DomainError("not-found", "未找到已提交日报。");
    return this.view(row, row.published, scopeMemberId);
  }
  published(
    scopeMemberId: string,
    range: DateRange,
    filter: ProgressFilter = {},
  ) {
    return this.diaries.published(scopeMemberId, range).flatMap((row) => {
      if (
        !row.published ||
        (filter.memberId && row.authorId !== filter.memberId)
      )
        return [];
      const content = projectPublishedContent(row.published, filter);
      return content ? [this.view(row, content, scopeMemberId)] : [];
    });
  }
}
