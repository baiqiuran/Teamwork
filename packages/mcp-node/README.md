# 日序 Node MCP 包

本地 stdio → 日序远程 `/mcp`（Streamable HTTP）。仅转发工具发现和工具调用，不复制业务逻辑、不保存 Key、不自动重试写操作。服务端按成员授权执行；OAuth 接入继续可用。

## 准备

1. 使用 Node.js 22 或更高版本。
2. 日序网页打开「AI 连接 → 通过 Node 连接」，填写名称、选择能力并生成 Key。
3. 复制网页生成的 Codex 配置；Key 只显示一次，忘记时需生成新 Key。默认选择查询和本人草稿，其余能力需要明确选择。Key 持续有效直到成员撤销。

## Windows Codex 接入

日序网页会生成包含当前站点地址和本人 Key 的完整配置。将片段追加到 Windows 用户级 Codex 配置 `%USERPROFILE%\.codex\config.toml`，重启 Codex，然后使用 `/mcp` 查看连接。请 Codex 使用日序工具列出项目，即可进行不修改数据的连接测试。Codex OAuth 仍可用；若同时配置两条日序连接，建议只启用其中一条以免工具重复。

配置结构如下；实际使用时应复制网页生成的片段，不要把 Key 提交到仓库或写入日志：

```toml
[mcp_servers.daily_flow_node]
command = "cmd"
args = ["/c", "npx", "--yes", "--package=daily-flow-mcp@0.1.0", "daily-flow-mcp"]

[mcp_servers.daily_flow_node.env]
DAILY_FLOW_URL = "https://team.example.com/mcp"
DAILY_FLOW_API_KEY = "dfk_替换为你的授权Key"
```

首次使用 npx 需要联网下载固定版本的包及其依赖。Key 在用户级配置中以明文保存；本地包不会持久化它。

## 配置与行为

- `DAILY_FLOW_URL`：日序源地址或 `/mcp` 地址；远程必须 HTTPS，本机 localhost/127.0.0.1/IPv6 回环允许 HTTP。拒绝地址中的账号、查询参数、片段和其他子路径。
- `DAILY_FLOW_API_KEY`：通过环境变量传入。转接包放到 `Authorization: Bearer …` 头，不放 URL，不向重定向地址传递。
- 工具名称、参数、输出 schema、结果、错误及服务端 instructions 保留。工具列表每次向服务端查询，不缓存已撤销的授权能力。
- 写入沿用原 `operationId`，结果不确定时只允许以相同标识重试；业务版本冲突需要成员新的处理指令。
- 连接关闭或进程收到 SIGINT/SIGTERM 时关闭两侧连接。stdout 只写 MCP 消息，诊断写 stderr 且不包含 Key。
- 撤销通过日序网页完成，随后工具列表、调用和旧回执重放均被拒绝。

## 验证

在应用根目录构建服务后运行 `node node_modules/tsx/dist/cli.mjs --test tests/mcp-keys.test.ts`；测试以隔离数据库、真实 MCP stdio 子进程和 HTTP 服务验证读取、写入、幂等、权限与撤销。
