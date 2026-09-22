import type { DiaryState } from "../domain/diary.ts";
import type { DateRange } from "../../../shared/domain/date.ts";

export interface DiaryDeletion {
  diaryId: string;
  memberId: string;
  action: string;
  at: number;
}

export interface SubmissionReceipt {
  memberId: string;
  requestId: string;
  diaryId: string;
  inputVersion: number;
  result: DiaryState & { editable: boolean };
}

export interface MemberSubmissionDate {
  memberId: string;
  diaryDate: string;
}

export interface DiaryRepository {
  find(id: string): DiaryState | undefined;
  mine(memberId: string): DiaryState[];
  published(memberId: string, range: DateRange): DiaryState[];
  latestSubmitted(memberId: string): MemberSubmissionDate[];
  save(diary: DiaryState): void;
  remove(id: string): void;
  deletion(id: string, memberId: string): DiaryDeletion | undefined;
  deletions(memberId: string): DiaryDeletion[];
  addDeletion(event: DiaryDeletion): void;
  receipt(memberId: string, requestId: string): SubmissionReceipt | undefined;
  addReceipt(receipt: SubmissionReceipt): void;
}
