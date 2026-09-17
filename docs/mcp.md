# Codex 与日序 MCP

日序保留网页，在同一个 Nest 服务增加 `/mcp` Streamable HTTP 入口。Codex 使用成员授权调用原有应用用例；网页 Cookie 登录、草稿与提交快照、日期窗口及公开范围继续生效。AI 的成功写入会改变同一份业务数据，网页重新读取后可见。双方同时编辑时旧版本被拒绝，不自动覆盖。

## 能力与使用边界

| 授权             | 默认选择 | 工具                                                                                                                                        |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `progress:read`  | 是       | `list_members`、`list_projects`、`get_project`、`list_tasks`、`get_task`、`list_task_events`、`list_diaries`、`query_progress`、`get_diary` |
| `drafts:write`   | 是       | `list_my_drafts`、`get_my_draft`、`create_draft`、`update_draft`                                                                            |
| `diaries:submit` | 否       | `submit_diary`                                                                                                                              |
| `tasks:write`    | 否       | `create_task`、`update_task_status`                                                                                                         |
| `shares:manage`  | 否       | `list_my_shares`、`create_share`、`close_share`                                                                                             |

`get_context` 向任一有效连接返回当前成员、授权、服务器时间和北京时间日期。工具只显示当前获准范围；实际调用仍复核权限。提交包含新任务或状态意图的草稿时，还必须有任务能力。只可读写自己的私人草稿、管理自己的分享和连接；团队进展只读提交版本。

查询页默认 20 条、最多 50 条。摘要标明 `summary`，裁剪文本带 `truncated`；长日报按工作条目和每段最多 4,000 个 Unicode 字符续读。使用 `nextCursor` 直至为空，内容或筛选变化时停止拼接旧页并重新查询。同名对象返回候选，工具说明要求成员明确选择 ID。

所有写工具要求 `operationId`。网络重试沿用同一个标识；同成员换连接重试仍去重，原能力不足或授权已撤销时不能读取回执。相同标识不同参数或工具返回 `operation-id-conflict`。回执带 `executedAt` 和 `replayed`，是历史结果；当前版本、分享是否仍开放应重新查询。成员给出新的处理指令后才使用新版本和新标识。

日报条目最多关联一个项目及其任务；临时工作无需关联。未指定已有日报时新建草稿，指定 ID 时通过 add/update/remove 条目操作补充，省略内容保留。附件只返回元数据、保留原引用；删除有附件的条目、上传下载和增删附件仍在网页完成。项目维护和邀请也在网页完成。

提交更新已有公开页；独立任务状态更新会改变已有公开任务模块的当前状态，历史日报状态快照不变。分享必须明确类型、对象、有效日期和模块；日报分享覆盖日期内全团队完整提交，不能限定成单成员。首版无服务端定时任务。

## 成员连接 Codex

已验证版本：Codex CLI/app-server **0.145.0**，MCP TypeScript server/node/client SDK **2.0.0**，Node **24.15.0**。实际 Codex 经过浏览器授权、工具调用、完整工作流程、15 分钟到期自动续期和撤销验证；测试使用独立 Codex 配置及隔离团队。服务不开放动态客户端注册。

在自己的 Codex `config.toml` 增加（替换域名）：

```toml
[mcp_servers.daily_flow]
url = "https://team.example.com/mcp"

[mcp_servers.daily_flow.oauth]
client_id = "daily-flow-codex"
callback_url = "http://127.0.0.1/callback"
```

请求需要的能力：

```sh
codex mcp login daily_flow --scopes progress:read,drafts:write,diaries:submit,tasks:write,shares:manage
```

密码只填写在日序网页。授权页默认仅勾选查询和自己的草稿，其余能力由成员明确勾选；授权后无需逐次确认。网页“AI 连接”可查看能力、最近活动、逐个撤销并读取本人操作记录。扩大权限需要重新授权；旧连接保留原范围，可按需撤销。

**回调登记是管理员配置步骤。** Codex 0.145.0 的实际回调会在 `/callback` 后附上连接标识，管理员须从授权请求的 `redirect_uri` 取得完整路径并通过 `DAILY_CODEX_REDIRECT_URIS` 登记。只记录回调地址，不保存或发送整条包含 state/PKCE 的授权 URL。不带端口的登记仅允许该本机主机与精确路径使用动态端口；路径和主机不支持通配符。服务地址或 Codex 配置变化后须核对实际回调。更新登记并重启服务后重新发起登录。

```powershell
$env:DAILY_CODEX_REDIRECT_URIS = '["http://127.0.0.1/callback/实际连接标识"]'
```

默认登记 `/callback` 供兼容客户端和接口测试使用；它不代表任意 `/callback/*`。测试中的 app-server 实际回调带连接标识；本版没有宣称 `authorization_response_iss_parameter_supported`，以实际互通结果为准。OAuth 响应仍携带 issuer。

成员授权不按 30/90 天过期。访问凭证 15 分钟有效，刷新凭证每次原子轮换，只保存摘要。授权码 2 分钟有效且单次使用，绑定客户端、回调、资源和 PKCE S256。Codex 刷新时可以省略 resource，服务从可信站点地址确定唯一资源；提供错误 resource 仍被拒绝。撤销同时阻断旧访问凭证、刷新和回执重放；网页会话继续可用。

## 运行配置与 HTTPS

| 配置                        | 默认                            | 含义                                                                   |
| --------------------------- | ------------------------------- | ---------------------------------------------------------------------- |
| `DAILY_PUBLIC_URL`          | 空，本机模式                    | 精确 HTTPS 源地址，例如 `https://team.example.com`；不带子路径和尾斜线 |
| `DAILY_CODEX_REDIRECT_URIS` | `["http://127.0.0.1/callback"]` | 预注册客户端的精确回调列表，JSON 数组                                  |
| `DAILY_MCP_MEMBER_LIMIT`    | 240                             | 每分钟每成员的 MCP HTTP 请求数，跨连接累计                             |
| `DAILY_MCP_GRANT_LIMIT`     | 120                             | 每分钟每授权连接请求数                                                 |
| `DAILY_MCP_MAX_BODY_BYTES`  | 16777216                        | MCP JSON 上限，支持 4–16 MiB；默认兼容最大合法日报及 JSON 转义开销     |

限流包含初始化及协议请求，429 返回 `Retry-After`；超限正文返回 413。分页和正文限制继续独立校验，不因 HTTP 上限提高而扩大业务容量。访问日志不应记录 Authorization、Cookie、token 请求体或完整授权查询串。

单机部署时 Node 继续监听 `127.0.0.1:4310`，由同机反向代理终止 TLS。仅信任回环代理；多机代理或容器网络须另行设计可信代理范围，不能直接改为信任所有代理。

1. 无公开地址配置时，先从本机建立首位成员；已有团队略过。
2. 停止服务并备份数据，完成构建，设置公开源地址、数据路径和精确回调，再启动。
3. 配置 TLS 证书和同机代理。示例 Nginx location 放在正确域名的 HTTPS server 中：

```nginx
client_max_body_size 28m; # 网页附件入口；MCP 自身另有 16 MiB 上限
location / {
    proxy_pass http://127.0.0.1:4310;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 60s;
}
```

域名、证书文件及进程托管配置由真实服务器环境补齐。不要将 4310 暴露公网。代理覆盖来源头，不能沿用客户端伪造的 `X-Forwarded-For`。应用校验 Host 和存在的 Origin；网页写操作仍必须同源并带 Cookie，MCP 使用 Bearer。HTTPS 代理访问的会话 Cookie 带 Secure。发现、OAuth 和 MCP 路由不会回退为 SPA HTML。

本轮只在隔离环境模拟可信 HTTPS 代理头并验证安全约束，尚未提供真实服务器与域名：**公网 TLS、DNS、跨电脑 Codex 接入和真实团队登录未验收、未部署**。

## 升级与恢复

本版使用 SQLite 有序迁移，支持版本到 6。增加客户端、授权、凭证摘要、回执及审计；显式重建任务事件表，保留旧 ID/成员/任务/日报/时间，将旧事件标记为 diary/web；独立事件为 direct/mcp 且无日报 ID。迁移全部成功后才监听，失败回滚并释放资源；超出支持版本的数据库会被拒绝。

升级前停止所有写入进程，同批复制数据库、仍存在的 WAL/SHM 和同级 `attachments/`，保留对应旧程序与锁文件；先在副本上运行新版本和验收。不要让新旧版本同时写同一个数据库。

回退时停止新服务、另存升级后数据，再恢复同一批旧备份和匹配的旧程序。**旧程序不能直接写升级后的库。恢复旧备份会丢失备份之后的全部新写入，包括 MCP 操作和授权。** 若不能接受此取舍，应保持新服务停写，先修复或制定数据恢复方案。

隔离升级脚本以历史提交 `4414749` 创建旧资产，验证账号、邀请、会话、私人草稿、提交回执、状态事件、公开令牌及附件保留，并演练恢复旧备份；迁移失败/未来版本由运行边界测试覆盖。备份内的有效公开令牌和凭证摘要按团队私有数据保管，不纳入 Git。

## 验证与诊断

```sh
npm run build
npm test
npm run test:upgrade
npm run test:production
```

`test:production` 本身会在干净目录安装并运行一次完整测试，然后在仅运行依赖目录通过编译产物验证 HTTP、OAuth 和 MCP。日常不必把它与 `npm test` 重复执行。实际 Codex 验收另行运行：

```powershell
$env:CODEX_TEST_BINARY = 'Codex 可执行文件的绝对路径'
node scripts/verify-codex-mcp.mjs
# 如需再次验证真实到期刷新，在运行前设置；脚本会等待约 15 分钟。
$env:CODEX_EXPIRY_WAIT = '1'
node scripts/verify-codex-mcp.mjs
```

脚本建立临时数据库、隔离 Codex 配置、临时浏览器和不发起模型推理的临时会话，实际走 app-server 的 OAuth 与 MCP 调用；结束后清理。候选选择和冲突后的新指令由验收脚本明确提供，不对模型随机措辞做自动断言，也不能据此宣称所有自然语言指令一定正确。

| 现象                              | 处理                                                                     |
| --------------------------------- | ------------------------------------------------------------------------ |
| 回调未登记                        | 核对实际 redirect_uri 的主机、路径与允许的端口规则，登记后重启并重新登录 |
| `invalid_token` / `invalid_grant` | 检查连接是否撤销、资源地址是否改变；刷新失败时重新授权，不恢复旧刷新凭证 |
| `insufficient_scope`              | 提交有任务意图时还需 tasks:write；网页重新授权所需能力                   |
| `version-conflict` / `conflict`   | 停止写入或分页拼接，将差异交给成员；新指令才读取新版本处理               |
| `operation-id-conflict`           | 同一标识已用于另一意图；核对请求，禁止用改标识方式盲目重试冲突           |
| `history-locked`                  | 首次提交日期已过去，不能补写或重新提交                                   |
| `archived` / `share-closed`       | 对象已归档或分享已关闭；重放不会重新开放                                 |
| 403 Host/Origin                   | 核对公开源地址、代理 Host、浏览器同源请求，勿关闭来源校验                |
| 429 / 413                         | 遵守重试间隔，检查合法内容大小和限流配置                                 |
| 启动迁移失败                      | 保留诊断与备份，检查数据库版本；不要用旧程序直接打开新库                 |

协议和客户端参考：[MCP SDK](https://ts.sdk.modelcontextprotocol.io/v2/)、[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。实际依赖固定于锁文件，后续升级需重跑互通测试。
