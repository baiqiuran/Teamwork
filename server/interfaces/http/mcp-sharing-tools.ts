import type { McpTools } from "./mcp-tools.ts";
import {
  createShareInput,
  closeShareInput,
} from "../../domain/ai-operation.ts";
import { shareListInput } from "../../domain/ai-query.ts";
import type { AiSharing } from "../../application/ai-sharing.ts";
import type { Capability } from "../../domain/ai-authorization.ts";
import type { AiAccess } from "../../application/ai-operations.ts";
import { toolResult } from "./mcp-result.ts";
export function registerSharingTools(
  server: McpTools,
  sharing: AiSharing,
  access: AiAccess,
  scopes: Capability[],
) {
  if (!scopes.includes("shares:manage")) return;
  server.registerTool(
    "create_share",
    {
      description:
        "创建公开链接，必须明确类型、对象、日期范围和模块。日报链接公开全团队完整已提交日报，范围不明须询问。重放回执是历史结果，不代表链接当前仍有效。",
      inputSchema: createShareInput,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
      },
    },
    (input) => toolResult(() => sharing.create(access, input)),
  );
  server.registerTool(
    "close_share",
    {
      description: "仅关闭本人创建的公开链接。重复关闭无副作用。",
      inputSchema: closeShareInput,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: true,
      },
    },
    (input) => toolResult(() => sharing.close(access, input)),
  );
  server.registerTool(
    "list_my_shares",
    {
      description: "分页读取本人链接及当前是否关闭。",
      inputSchema: shareListInput,
      annotations: { readOnlyHint: true },
    },
    (input) => toolResult(() => sharing.list(access, input)),
  );
}
