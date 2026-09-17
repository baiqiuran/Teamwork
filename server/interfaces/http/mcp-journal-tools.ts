import type { McpTools } from "./mcp-tools.ts";
import { pageInput, detailInput } from "../../domain/ai-query.ts";
import {
  createDraftInput,
  updateDraftInput,
  submitDiaryInput,
} from "../../domain/ai-operation.ts";
import type { AiJournal } from "../../application/ai-journal.ts";
import type { Capability } from "../../domain/ai-authorization.ts";
import type { AiAccess } from "../../application/ai-operations.ts";
import { toolResult } from "./mcp-result.ts";
export function registerJournalTools(
  server: McpTools,
  journal: AiJournal,
  access: AiAccess,
  scopes: Capability[],
) {
  if (scopes.includes("diaries:submit"))
    server.registerTool(
      "submit_diary",
      {
        description:
          "提交明确指定的本人草稿，将更新项目归集、任务状态及既有公开页。含任务变更需同时获得 tasks:write。冲突停止。",
        inputSchema: submitDiaryInput,
        annotations: {
          readOnlyHint: false,
          idempotentHint: true,
          destructiveHint: true,
        },
      },
      (input) => toolResult(() => journal.submit(access, input)),
    );
  if (!scopes.includes("drafts:write")) return;
  server.registerTool(
    "update_draft",
    {
      description:
        "只修改成员明确指定的日报和条目；保留未指定内容及附件。版本冲突必须停止等待新指令，不得自动重试覆盖。",
      inputSchema: updateDraftInput,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: true,
      },
    },
    (input) => toolResult(() => journal.update(access, input)),
  );
  server.registerTool(
    "create_draft",
    {
      description:
        "默认新建本人日报草稿。必须复用 operationId 重试，不会提交或更改任务。不得伪造附件或日期。",
      inputSchema: createDraftInput,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
      },
    },
    (input) => toolResult(() => journal.create(access, input)),
  );
  server.registerTool(
    "list_my_drafts",
    {
      description: "分页查看本人草稿摘要及可编辑性，包括待重提修改。",
      inputSchema: pageInput.strict(),
      annotations: { readOnlyHint: true },
    },
    (input) => toolResult(() => journal.list(access, input)),
  );
  server.registerTool(
    "get_my_draft",
    {
      description:
        "按明确 ID 分段读取本人草稿，保留条目 ID 与版本。传回 nextCursor 读取后续内容。",
      inputSchema: detailInput,
      annotations: { readOnlyHint: true },
    },
    (input) => toolResult(() => journal.get(access, input)),
  );
}
