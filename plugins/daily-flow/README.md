# 日序 Codex 插件

在 Codex 中查询团队进展、整理本人日报、提交日报、维护任务状态和管理公开链接。插件包含 [daily-flow 技能](skills/daily-flow/SKILL.md)，按成员授权使用服务端实际开放的 MCP 工具。

默认连接名为 `daily_flow_local`，地址为 `http://127.0.0.1:4310/mcp`，使用 `DAILY_FLOW_API_KEY` 环境变量。这个 HTTP 连接不读取密钥文件；需要文件引用时使用下方的 Node 方案。技能也可配合已有日序 OAuth 或 Node 连接使用，多条连接时按用户指定的服务选择，避免混用本机和线上数据。

## 安装与首次使用

1. 在应用仓库根目录 `app` 按项目 README 安装、构建并启动日序服务。Codex 与服务在同一台电脑时可使用默认地址。
2. 在日序网页「AI 连接 → 通过 Node 连接」创建命名授权 Key，选择所需能力。此处创建的 Key 同样适用于 HTTP 连接。默认查询和本人草稿；提交、任务写入和分享需要各自能力。
3. 由成员在模型工具之外将 Key 配入可信启动环境的 `DAILY_FLOW_API_KEY`，再启动 Codex。桌面版需完全退出后从该环境启动。Key 不进入聊天、插件文件、配置正文、终端命令或日志；不要让模型读取环境变量验证它。
4. 在应用仓库根目录安装仓库 marketplace 与插件（这是显式的仓库 marketplace，不是用户目录下自动发现的个人 marketplace）：

   ```powershell
   codex plugin marketplace add .
   codex plugin add daily-flow@personal
   ```

   已登记本仓库的 marketplace 时，只需第二条命令。名称 `personal` 来自本仓库 `.agents/plugins/marketplace.json`；若存在同名的其他 marketplace，先核对 `codex plugin marketplace list` 中的路径，不要覆盖其他来源。

5. 新建 Codex 任务，请它使用日序的 `get_context` 核对当前成员、能力和北京时间日期，再用 `list_projects` 做只读连接验证。项目列表为空也是成功；只安装插件不代表认证成功。

## 常用请求

- “使用日序，汇总今天团队已提交的进展，并标出阻塞项。”
- “把下面的工作内容保存成我的日序草稿，暂不提交。”
- “把日序项目 A 中任务 B 的状态改为进行中。”

也可显式选择 `daily-flow` 技能。保存草稿保持私有；提交更新团队进展及已有公开页。用户已明确要求的操作在现有授权范围内执行，缺失对象或分享范围时才补充询问。

## 使用密钥文件接入

新建 Key 连接推荐使用项目现有的 Node 转接包：成员自行将 Key 保存为仓库外 UTF-8 文件，客户端只配置文件路径。该方式不依赖桌面版继承 Key 环境变量。

1. 在应用仓库 `packages/mcp-node` 运行 `npm pack`，将生成的 `daily-flow-mcp-0.1.0.tgz` 保存到 Codex 所在电脑。需要 Node.js 22 或更新版本。该包尚未发布到 npm，使用自己的本地 tarball。
2. 将以下**示例**配置中的包路径、HTTPS 服务地址和密钥文件路径替换成实际值。成员自行在客户端配置中录入，文件只含 Key，可带末尾换行。

   ```toml
   [mcp_servers.daily_flow_node]
   command = "cmd"
   args = ["/c", "npx", "--yes", "--package=C:/tools/daily-flow-mcp-0.1.0.tgz", "daily-flow-mcp"]

   [mcp_servers.daily_flow_node.env]
   DAILY_FLOW_URL = "https://team.example.com/mcp"
   DAILY_FLOW_API_KEY_FILE = "C:/Users/你的用户名/.daily-flow/member.key"
   ```

3. Node 进程只配置一种 Key 来源：使用文件时，移除该进程继承的 `DAILY_FLOW_API_KEY`。两者同时存在（包括空值）会拒绝启动。路径必须是绝对路径，`~`、`%USERPROFILE%` 不会展开。首次 npx 启动可能需要下载依赖。
4. 重启客户端，在新任务中明确使用 `daily_flow_node`，进行上述只读验证。安装的插件仍提供技能；它的默认 HTTP 连接并不会自动变成 Node 连接。技能只能使用客户端已成功连接的那一条服务。

OAuth 也可与插件技能配合，按应用仓库 `docs/mcp.md` 接入。完整 Node 说明位于应用仓库 `packages/mcp-node/README.md`。这些仓库文档不是插件安装副本的运行依赖。

## 远程服务与故障处理

默认 HTTP 连接只用于本机开发。需要远程服务时，核对目标团队后将插件源文件 `.mcp.json` 的 `url` 改为该服务的 HTTPS `/mcp` 地址并重新安装。Key 会发送到配置地址，不应尝试向其他地址自动重连。

| 现象                     | 处理                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 连接拒绝或超时           | 检查服务是否启动、端口是否匹配，以及 Codex 所在电脑能否访问该地址。                                        |
| 缺少环境变量或认证失败   | HTTP 方式核对启动环境；Node 方式由成员核对文件引用及单一凭证来源。在网页核对连接是否撤销，不输出真实凭证。 |
| 缺少提交、任务或分享工具 | 用 `get_context` 核对授权；成员在网页创建所需能力的连接后重新接入。插件不能自行扩大权限。                  |
| 本机和线上工具同时出现   | 指定目标连接；对象 ID、版本和重试均留在该服务中。                                                          |
| 版本冲突                 | 停止写入，读取当前状态并等待用户的新处理指令。                                                             |
| 写请求超时，结果未知     | 使用原工具、原参数和原 `operationId` 重试；持续失败时报告结果待确认。                                      |
| 更新后没有技能           | 重新安装插件并新建 Codex 任务，当前任务不保证热加载新技能。                                                |

详细操作边界见 [技能](skills/daily-flow/SKILL.md) 及其引用文档。凭证需要变更时，成员自行创建新 Key、完成只读验证，再决定撤销旧 Key。

## 开发与更新

在应用仓库根目录操作。`plugin-creator` 技能位于默认 Codex 安装位置时，可运行下面的命令；Python 环境需提供 PyYAML。

```powershell
$pluginTools = Join-Path $env:USERPROFILE '.codex/skills/.system/plugin-creator/scripts'
$skillTools = Join-Path $env:USERPROFILE '.codex/skills/.system/skill-creator/scripts'
python "$pluginTools/read_marketplace_name.py" --marketplace-path .agents/plugins/marketplace.json
python "$pluginTools/validate_plugin.py" plugins/daily-flow
python -X utf8 "$skillTools/quick_validate.py" plugins/daily-flow/skills/daily-flow
python "$pluginTools/update_plugin_cachebuster.py" plugins/daily-flow
codex plugin add daily-flow@personal
```

每条命令成功后再执行下一条；marketplace 名称或路径与当前仓库不符时先核对来源。更新工具保留基础版本，只替换 Codex 缓存后缀，无需手工修改 marketplace。重新安装后，新建任务加载更新的技能与工具。
