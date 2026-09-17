import type { ShareState } from "../domain/sharing.ts";

export interface SharingRepository {
  find(id: string): ShareState | undefined;
  byToken(token: string): ShareState | undefined;
  mine(memberId: string): ShareState[];
  save(share: ShareState): void;
  closeForProject(projectId: string, at: number): void;
  closeForTask(taskId: string, at: number): void;
}
