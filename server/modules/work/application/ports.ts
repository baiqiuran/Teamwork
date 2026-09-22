import type { ProjectState, TaskState } from "../domain/work.ts";
import type { TaskEvent } from "../domain/task-event.ts";

export interface WorkRepository {
  project(id: string, memberId: string): ProjectState | undefined;
  projects(memberId: string): ProjectState[];
  saveProject(project: ProjectState): void;
  task(id: string, memberId: string): TaskState | undefined;
  tasks(memberId: string, projectId?: string): TaskState[];
  saveTask(task: TaskState): void;
  addEvent(event: TaskEvent): void;
  events(taskId: string, memberId: string): TaskEvent[];
}
