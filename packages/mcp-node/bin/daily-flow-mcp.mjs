#!/usr/bin/env node
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

// Configuration is never included in errors, stderr, or tool output.
function configuration() {
  const hasKey = Object.hasOwn(process.env, "DAILY_FLOW_API_KEY");
  const hasFile = Object.hasOwn(process.env, "DAILY_FLOW_API_KEY_FILE");
  if (hasKey && hasFile)
    throw new Error(
      "DAILY_FLOW_API_KEY_FILE 与 DAILY_FLOW_API_KEY 不能同时设置（包括空值）。",
    );
  if (!hasKey && !hasFile)
    throw new Error(
      "请设置 DAILY_FLOW_API_KEY_FILE（推荐）或 DAILY_FLOW_API_KEY，且仅设置其中一个。",
    );
  let key;
  if (hasFile) {
    const file = process.env.DAILY_FLOW_API_KEY_FILE;
    if (!file || !isAbsolute(file))
      throw new Error("DAILY_FLOW_API_KEY_FILE 须为非空的本机绝对路径。");
    try {
      // Read only at startup; never surface native errors containing the path.
      key = readFileSync(file, "utf8");
    } catch {
      throw new Error("无法读取 Key 文件，请检查文件是否存在且可读。");
    }
    if (!key.trim()) throw new Error("Key 文件不能为空或仅含空白。");
    // Editors may append LF or CRLF, but other whitespace is not part of a Key.
    key = key.replace(/(?:\r?\n)+$/, "");
  } else {
    key = process.env.DAILY_FLOW_API_KEY;
  }
  if (!key || key.trim() !== key || !/^dfk_[A-Za-z0-9_-]+$/.test(key))
    throw new Error(
      hasFile
        ? "Key 文件格式无效，请仅保存成员授权 Key（允许末尾换行）。"
        : "请设置有效的 DAILY_FLOW_API_KEY。",
    );
  let url;
  try {
    url = new URL(process.env.DAILY_FLOW_URL);
  } catch {
    throw new Error("请设置有效的 DAILY_FLOW_URL（服务地址或 /mcp 地址）。");
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/", "/mcp", "/mcp/"].includes(url.pathname)
  )
    throw new Error(
      "服务地址须为 HTTPS 源地址或 /mcp 地址；仅本机允许 HTTP，不接受账号、查询参数或片段。",
    );
  url.pathname = "/mcp";
  return { url, key };
}

let remote;
let local;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await Promise.allSettled([local?.close(), remote?.close()]);
}
async function main() {
  const { url, key } = configuration();
  remote = new Client({ name: "daily-flow-node", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: { Authorization: `Bearer ${key}` },
      redirect: "error",
    },
    fetch: (input, init) => {
      const target = new URL(
        input instanceof Request ? input.url : String(input),
      );
      if (target.href !== url.href)
        throw new Error("不允许向其他地址发送凭证。");
      return fetch(input, { ...init, redirect: "error" });
    },
  });
  try {
    await remote.connect(transport);
  } catch {
    throw new Error(
      "无法连接日序 MCP，请检查服务地址、网络和 Key 是否有效或已撤销。",
    );
  }
  local = new Server(
    { name: "daily-flow-node", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: remote.getInstructions(),
    },
  );
  local.setRequestHandler("tools/list", async (request, ctx) => {
    try {
      return await remote.listTools(request.params, {
        cacheMode: "bypass",
        signal: ctx.mcpReq.signal,
      });
    } catch {
      throw new Error("无法读取工具，请检查连接和 Key 是否已撤销。");
    }
  });
  local.setRequestHandler("tools/call", async (request, ctx) => {
    try {
      return await remote.callTool(request.params, {
        signal: ctx.mcpReq.signal,
      });
    } catch {
      // Do not automatically retry writes: the remote outcome may be unknown.
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "调用未完成，请检查连接或授权。若重试写操作，请沿用原 operationId。",
          },
        ],
      };
    }
  });
  local.onclose = () => {
    void close();
  };
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
  process.stdin.once("end", () => {
    void close();
  });
  await local.connect(new StdioServerTransport());
}
main().catch(async (error) => {
  console.error(error.message);
  await close();
  process.exitCode = 1;
});
