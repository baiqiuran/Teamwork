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

export interface DiaryRepository {
  find(id: string): DiaryState | undefined;
  mine(memberId: string): DiaryState[];
  published(range: DateRange): DiaryState[];
  save(diary: DiaryState): void;
  remove(id: string): void;
  deletion(id: string, memberId: string): DiaryDeletion | undefined;
  deletions(): DiaryDeletion[];
  addDeletion(event: DiaryDeletion): void;
  receipt(memberId: string, requestId: string): SubmissionReceipt | undefined;
  addReceipt(receipt: SubmissionReceipt): void;
}
