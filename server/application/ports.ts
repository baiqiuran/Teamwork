import type { Attachment } from "../domain/attachment.ts";
import type { DateRange, DiaryState, TaskStatus } from "../domain/diary.ts";
import type {
  Account,
  InvitationState,
  Member,
  Team,
} from "../domain/membership.ts";
import type { ShareState } from "../domain/sharing.ts";
import type { ProjectState, TaskState } from "../domain/work.ts";

export interface Runtime {
  now(): number;
  id(): string;
  /** All repository writes in the callback commit or roll back together. Callbacks must be synchronous. */
  transaction<T>(work: () => T): T;
}
export interface Security {
  secret(): string;
  digest(value: string): string;
  hashPassword(password: string): Promise<string>;
  verifyPassword(password: string, hash: string): Promise<boolean>;
  dummyPasswordHash: string;
}
export interface MembershipRepository {
  team(): Team | undefined;
  createTeam(name: string): void;
  member(id: string): Member | undefined;
  members(): Pick<Member, "id" | "name">[];
  account(email: string): Account | undefined;
  addAccount(account: Account): void;
  session(tokenHash: string, now: number): Member | undefined;
  addSession(
    tokenHash: string,
    memberId: string,
    expiresAt: number,
    now: number,
  ): void;
  deleteSession(tokenHash: string): void;
  invitation(id: string): InvitationState | undefined;
  invitationByToken(tokenHash: string): InvitationState | undefined;
  invitations(memberId: string): InvitationState[];
  saveInvitation(invitation: InvitationState): void;
}
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
export interface TaskEvent {
  id: string;
  taskId: string;
  diaryId: string;
  memberId: string;
  before: TaskStatus;
  after: TaskStatus;
  at: number;
}
export interface WorkRepository {
  project(id: string): ProjectState | undefined;
  projects(): ProjectState[];
  saveProject(project: ProjectState): void;
  task(id: string): TaskState | undefined;
  tasks(projectId?: string): TaskState[];
  saveTask(task: TaskState): void;
  addEvent(event: TaskEvent): void;
  events(taskId: string): TaskEvent[];
}
export interface SharingRepository {
  find(id: string): ShareState | undefined;
  byToken(token: string): ShareState | undefined;
  mine(memberId: string): ShareState[];
  save(share: ShareState): void;
  closeForProject(projectId: string, at: number): void;
  closeForTask(taskId: string, at: number): void;
}
export interface AttachmentRepository {
  find(id: string): Attachment | undefined;
  byRequest(memberId: string, requestId: string): Attachment | undefined;
  add(file: Attachment): void;
}
export interface FileStorage {
  write(id: string, bytes: Uint8Array): void;
  remove(id: string): void;
  read(id: string): Uint8Array;
}
