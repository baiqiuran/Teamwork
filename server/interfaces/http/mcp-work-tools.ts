import type { McpTools } from "./mcp-tools.ts";
import { createTaskInput, updateTaskInput } from "../../domain/ai-operation.ts";
import type { AiWork } from "../../application/ai-work.ts";
import type { Capability } from "../../domain/ai-authorization.ts";
import type { AiAccess } from "../../application/ai-operations.ts";
import { toolResult } from "./mcp-result.ts";
export function registerWorkTools(
  server: McpTools,
  work: AiWork,
  access: AiAccess,
  scopes: Capability[],
) {
  if (!scopes.includes("tasks:write")) return;
  server.registerTool(
    "create_task",
    {
      description: "在明确项目下新建待开始任务。operationId 用于重试去重。",
      inputSchema: createTaskInput,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
      },
    },
    (input) => toolResult(() => work.create(access, input)),
  );
  server.registerTool(
    "update_task_status",
    {
      description:
        "独立更新任务状态，不生成日报，会更新既有公开链接任务模块的当前状态。必须有明确状态及版本；冲突停止，等待成员新指令。",
      inputSchema: updateTaskInput,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: true,
      },
    },
    (input) => toolResult(() => work.update(access, input)),
  );
}
