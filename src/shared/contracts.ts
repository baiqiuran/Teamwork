export interface Identity {
  member: { id: string; teamId: number; name: string; email: string };
  team: { id: number; name: string };
}
export interface TeamMember {
  id: string;
  name: string;
  joinedAt: number;
  lastDiaryDate: string | null;
}
export interface Invitation {
  id: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  status: "active" | "used" | "revoked" | "expired";
}

export interface Entry {
  id: string;
  body: string;
  attachments?: { id: string; name: string; size: number }[];
  projectId?: string;
  projectName?: string;
  taskId?: string;
  taskName?: string;
  taskStatus?: TaskStatus;
  newTask?: { name: string; description: string };
  statusChange?: {
    status: TaskStatus;
    expectedVersion: number;
    resolution?: "keep" | "apply";
  };
}
export interface DiaryContent {
  title: string;
  entries: Entry[];
}
export interface Diary {
  id: string;
  draft: DiaryContent;
  version: number;
  diaryDate: string | null;
  updatedAt: number;
  published: DiaryContent | null;
  editable: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  creator: { id: string; name: string };
  archived: boolean;
}

export type TaskStatus = "pending" | "in-progress" | "done";
export interface TaskEvent {
  kind: "diary" | "direct";
  channel: "web" | "mcp";
  id: string;
  member: { name: string };
  before: TaskStatus;
  after: TaskStatus;
  at: number;
}
export interface Task extends Project {
  projectId: string;
  status: TaskStatus;
  version: number;
}

export interface PublishedDiary {
  id: string;
  author: { id: string; name: string };
  diaryDate: string;
  submittedAt: number;
  published: DiaryContent;
}
