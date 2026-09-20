# 日序 Node MCP 包

本地 stdio → 日序远程 `/mcp`（Streamable HTTP）。仅转发工具发现和工具调用，不复制业务逻辑、不保存 Key、不自动重试写操作。服务端按成员授权执行；OAuth 接入继续可用。

## 准备

1. 使用 Node.js 22 或更高版本。
2. 日序网页打开「AI 连接 → 通过 Node 连接」，填写名称、选择能力并生成 Key。
3. 立即复制 Key；只显示一次，忘记时撤销并重新创建。默认选择查询和本人草稿，其余能力需要明确选择。Key 持续有效直到成员撤销。

## 本地包接入

这个包尚未发布到 npm；不要使用未核实的同名公共包。先在本目录运行 `npm pack`，将生成的 `daily-flow-mcp-0.1.0.tgz` 放在使用 AI 客户端的电脑上。

支持 MCP JSON 配置的客户端可使用：

```json
{
  "mcpServers": {
    "daily-flow": {
      "command": "npx",
      "args": [
        "--yes",
        "--package=/absolute/path/daily-flow-mcp-0.1.0.tgz",
        "daily-flow-mcp"
      ],
      "env": {
        "DAILY_FLOW_URL": "https://team.example.com/mcp",
        "DAILY_FLOW_API_KEY": "dfk_替换为你的授权Key"
      }
    }
  }
}
```

Windows 客户端若不能直接启动 `npx`，使用 `command: "cmd"`，并在 `args` 开头加 `"/c", "npx"`；包路径使用本机绝对路径，例如 `--package=C:/tools/daily-flow-mcp-0.1.0.tgz`。

首次使用 npx 可能需要下载包的 MCP SDK 依赖。也可以在本目录执行 `npm install`，配置客户端以 `node` 启动 `bin/daily-flow-mcp.mjs` 的绝对路径。

只有将来确认包名并发布到自己的 npm 账号后，才能把本地 tarball 路径替换成已经发布的包名和版本。

## 配置与行为

- `DAILY_FLOW_URL`：日序源地址或 `/mcp` 地址；远程必须 HTTPS，本机 localhost/127.0.0.1/IPv6 回环允许 HTTP。拒绝地址中的账号、查询参数、片段和其他子路径。
- `DAILY_FLOW_API_KEY`：通过环境变量传入。转接包放到 `Authorization: Bearer …` 头，不放 URL，不向重定向地址传递。
- 工具名称、参数、输出 schema、结果、错误及服务端 instructions 保留。工具列表每次向服务端查询，不缓存已撤销的授权能力。
- 写入沿用原 `operationId`，结果不确定时只允许以相同标识重试；业务版本冲突需要成员新的处理指令。
- 连接关闭或进程收到 SIGINT/SIGTERM 时关闭两侧连接。stdout 只写 MCP 消息，诊断写 stderr 且不包含 Key。
- 撤销通过日序网页完成，随后工具列表、调用和旧回执重放均被拒绝。

## 验证

在应用根目录构建服务后运行 `node node_modules/tsx/dist/cli.mjs --test tests/mcp-keys.test.ts`；测试以隔离数据库、真实 MCP stdio 子进程和 HTTP 服务验证读取、写入、幂等、权限与撤销。
