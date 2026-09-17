import type { TaskStatus } from "./task-status.ts";

export interface TaskEvent {
  id: string;
  taskId: string;
  diaryId: string | null;
  kind: "diary" | "direct";
  channel: "web" | "mcp";
  memberId: string;
  before: TaskStatus;
  after: TaskStatus;
  at: number;
}
