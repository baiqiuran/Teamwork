import { toolResult } from "./mcp-result.ts";
import type { McpTools } from "./mcp-tools.ts";
import {
  detailInput,
  idInput,
  progressInput,
  searchInput,
  taskListInput,
} from "../../application/query-contracts.ts";
import type { AiAuthorization } from "../../application/ai-authorization.ts";
import type { AiReading } from "../../application/ai-reading.ts";

export function registerReadingTools(
  server: McpTools,
  reading: AiReading,
  auth: AiAuthorization,
  token: string,
  resource: string,
) {
  const execute = (work: () => object) =>
    toolResult(() => auth.authorized(token, resource, ["progress:read"], work));
  if (
    !auth.authenticate(token, resource).grant.scopes.includes("progress:read")
  )
    return;
  const annotations = { readOnlyHint: true };
  server.registerTool(
    "list_members",
    {
      description: "查找成员候选；同名时询问成员，不自行选取。仅返回简要身份。",
      inputSchema: searchInput,
      annotations,
    },
    (input) => execute(() => reading.members(input)),
  );
  server.registerTool(
    "list_projects",
    {
      description:
        "按名称查找项目候选并分页。summary 表示摘要，请使用详情工具读取完整内容。",
      inputSchema: searchInput,
      annotations,
    },
    (input) => execute(() => reading.projects(input)),
  );
  server.registerTool(
    "get_project",
    {
      description: "按明确项目 ID 读取详情。",
      inputSchema: idInput,
      annotations,
    },
    (input) => execute(() => reading.project(input.id)),
  );
  server.registerTool(
    "list_tasks",
    {
      description: "按名称和项目查找任务；同名候选需询问成员。",
      inputSchema: taskListInput,
      annotations,
    },
    (input) => execute(() => reading.tasks(input)),
  );
  server.registerTool(
    "get_task",
    {
      description: "读取任务当前状态及版本；与历史日报状态快照不同。",
      inputSchema: idInput,
      annotations,
    },
    (input) => execute(() => reading.task(input.id)),
  );
  server.registerTool(
    "list_task_events",
    {
      description: "分页读取指定任务的状态变更历史。",
      inputSchema: detailInput,
      annotations,
    },
    (input) => execute(() => reading.events(input)),
  );
  server.registerTool(
    "list_diaries",
    {
      description:
        "读取团队完整已提交日报的摘要，默认北京时间今天，命中项目仍保留完整日报。",
      inputSchema: progressInput,
      annotations,
    },
    (input) => execute(() => reading.diaries(input, true)),
  );
  server.registerTool(
    "query_progress",
    {
      description:
        "按明确项目/任务筛选进展摘要，仅匹配条目归集；详情工具可按 entryIds 识别相关条目。",
      inputSchema: progressInput.refine(
        (input) => !!input.projectId || !!input.taskId,
        "请明确项目或任务。",
      ),
      annotations,
    },
    (input) => execute(() => reading.diaries(input, false)),
  );
  server.registerTool(
    "get_diary",
    {
      description:
        "分段读取完整已提交日报；持续传回 nextCursor 直至 null。冲突时停止并重新查询，附件仅元数据。",
      inputSchema: detailInput,
      annotations,
    },
    (input) => execute(() => reading.diary(input)),
  );
}
