import type { ProjectState, TaskState } from "../domain/work.ts";
import type { TaskEvent } from "../domain/task-event.ts";

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
