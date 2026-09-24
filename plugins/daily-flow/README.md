# 日序 Codex 插件

此插件将当前仓库的日序 MCP 服务接入 Codex。默认连接本机 `http://127.0.0.1:4310/mcp`，连接名为 `daily_flow_local`；服务端继续决定实际工具、业务权限和数据范围。
插件直接通过 HTTP 传递成员授权 Key，无需启动 `packages/mcp-node` 中的转接包。

如果 Codex 已配置线上 `daily_flow` OAuth 连接，两个连接会同时存在。操作前先确认要使用的是本机开发数据还是线上团队数据；不需要本机连接时可在 Codex 中停用此插件。

## 本机接入

1. 在仓库根目录启动日序。首次运行按项目 [README](../../README.md) 完成 `npm ci`、`npm run build` 和 `npm start`。
2. 使用自己的账号打开日序网页「AI 连接 → 通过 Node 连接」，创建一个命名授权 Key，按需要勾选能力。只读连接只选择 `progress:read`；创建本人草稿再选 `drafts:write`。
3. 让 Codex 进程继承环境变量 `DAILY_FLOW_API_KEY`。例如，在启动 Codex CLI 的 PowerShell 中设置：

   ```powershell
   $env:DAILY_FLOW_API_KEY = '网页中刚生成的 Key'
   codex
   ```

   Key 只显示一次，不要写入插件文件或提交到 Git。若使用桌面版，须从带有该环境变量的进程启动或通过系统环境配置后重启桌面版。
4. 安装当前仓库中的 marketplace 与插件：

   ```powershell
   codex plugin marketplace add .
   codex plugin add daily-flow@personal
   ```

5. 在新 Codex 任务中先请求 `get_context` 或列出项目，确认显示的是自己的成员身份与预期能力，再执行写操作。

## 远程日序服务

`.mcp.json` 的地址是本机开发默认值。若日序运行在其他电脑，将 `url` 改为你已核对的 HTTPS 日序地址，以 `/mcp` 结尾，并重新安装插件。成员授权 Key 会发送到此地址；不要把生产 Key 写进仓库。服务端仍只接受该成员 Key 已授权的能力。

关于能力、撤销、冲突和写入重试规则，见项目 [MCP 手册](../../docs/mcp.md)。网络结果不确定时，写操作仅用原 `operationId` 重试；版本冲突须由成员给出新指令。
