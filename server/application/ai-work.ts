import type {
  CreateTaskInput,
  UpdateTaskInput,
} from "../domain/ai-operation.ts";
import type { Work } from "./work.ts";
import type { AiOperations, AiAccess } from "./ai-operations.ts";
export class AiWork {
  constructor(
    private readonly work: Work,
    private readonly operations: AiOperations,
  ) {}
  create(access: AiAccess, input: CreateTaskInput) {
    return this.operations.run(
      access,
      "create_task",
      input,
      ["tasks:write"],
      (memberId) => {
        const task = this.work.createTask(input.projectId, memberId, input);
        return { result: { task }, objectId: task.id };
      },
    );
  }
  update(access: AiAccess, input: UpdateTaskInput) {
    return this.operations.run(
      access,
      "update_task_status",
      input,
      ["tasks:write"],
      (memberId) => ({
        result: this.work.updateStatus(
          input.id,
          memberId,
          input.status,
          input.expectedVersion,
          "mcp",
        ),
        objectId: input.id,
      }),
    );
  }
}
