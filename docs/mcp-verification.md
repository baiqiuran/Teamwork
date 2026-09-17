# MCP 实施验收记录

日期：2026-09-17。基线：`0670d95694356c3c8fe2ac6a3b07003fecfaa8e7`。

本地任务 `daily-flow-mcp` 的 01–10 按顺序实施。功能提交 `8a38f21`，审查修复 `36fc9cc`；最后的文档提交仅补验收证据和测试断言。网页与 MCP 共用 Nest 应用用例、领域规则和 SQLite；未迁移 PostgreSQL，未切换真实团队服务或改写个人 Codex 配置。

## 验证结果

| 验证                                 | 结果                                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 构建、TypeScript、架构边界与循环依赖 | 通过，85 个源码文件参与架构检查                                                                                                     |
| 干净安装最终全量接口测试             | 41/41 通过                                                                                                                          |
| 最终页面回归与仅运行依赖启动         | 10/10 页面测试通过；仅运行依赖的 HTTP/OAuth/MCP 启动与写入通过                                                                      |
| 仅运行依赖测试内容                   | 在不安装 tsx、TypeScript、Nest CLI 的独立目录，用编译后的 Node 产物验证 HTTP、OAuth、MCP 写入                                       |
| 旧数据升级及恢复                     | 通过；旧账号/会话/邀请/草稿/提交回执/状态事件/公开链接/附件保留，恢复旧备份后旧程序可用                                             |
| 实际 Codex                           | 0.145.0，隔离 app-server + 浏览器授权 + MCP SDK 2.0.0 服务                                                                          |
| Codex 完整流程                       | 默认权限、登录授权、候选查询、建任务、创建/补充草稿、网页交错编辑冲突、提交、独立任务更新、分享、团队网页、匿名公开页、撤销全部通过 |
| 真实到期续期                         | 独立运行等待 905 秒，15 分钟访问凭证到期后 Codex 自动续期成功；网页撤销后调用失败                                                   |
| 代码审查                             | Standards 初审 2 项、Spec 初审 3 项，均修复并复审关闭；无剩余已知审查项                                                             |

最终接口测试包括 17 项新增 MCP 相关场景；浏览器新增 1 项 AI 授权/连接/记录验收，并保留已有团队日报与公开页桌面瀑布布局检查。另有实际 Codex 脚本与升级恢复脚本。全量回归第一次发现网页大请求响应由基线 500 变成 413，修复为仅 MCP/OAuth 返回 413 后，原网页断言保持通过。

## 规格矩阵 M01–M30

测试文件均相对仓库 `tests/`；Codex 为 `scripts/verify-codex-mcp.mjs`，升级为 `scripts/verify-upgrade.mjs`，生产为 `scripts/verify-production.mjs`。

| 编号 | 验收证据及边界                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| M01  | `mcp-auth.test.ts`、实际 Codex：协议发现、按能力列工具、结构化结果及输出 schema；公网连接另列外部验收                                       |
| M02  | `browser/mcp.spec.ts`、实际 Codex：只在网页登录，默认查询/草稿，取消无授权，成员明确选择其他能力                                            |
| M03  | `mcp-auth.test.ts`：客户端、PKCE、资源、回调绑定及一次性授权码，拒绝伪造；无凭证进入工具结果                                                |
| M04  | `mcp-lifecycle.test.ts`、Codex 905 秒实际等待：过期续期、刷新轮换、长期授权                                                                 |
| M05  | `mcp-lifecycle.test.ts`、`mcp-consistency.test.ts`：撤销阻断访问、刷新和成功回执重放，重启及其他连接隔离                                    |
| M06  | `mcp-auth.test.ts`、`mcp-reading.test.ts`：直接调用隐藏工具、伪造身份字段被拒                                                               |
| M07  | `mcp-reading.test.ts`、`mcp-drafts.test.ts`：他人草稿不可访问，团队/公开读取只返回提交快照                                                  |
| M08  | `mcp-reading.test.ts`、`mcp-consistency.test.ts`：稳定分页、长正文续读、摘要/截断标记、变更游标拒绝                                         |
| M09  | `mcp-reading.test.ts`、`mcp-drafts.test.ts`、实际 Codex：返回多个候选、合法归属和临时工作；客户端说明要求询问，验收脚本明确提供选择         |
| M10  | `mcp-drafts.test.ts`：默认新建，按 ID 和条目补充，未指定内容/附件保留                                                                       |
| M11  | `mcp-consistency.test.ts`、`mcp-contracts.test.ts`：最大合法正文可保存；超限、伪造附件、追加第 51 条被拒，条目数/版本不变                   |
| M12  | `mcp-submission.test.ts`、实际 Codex：提交、项目/任务进展、完整团队日报、匿名公开读取一致                                                   |
| M13  | `mcp-submission.test.ts`：基于已持久化草稿复核任务能力，权限不足整次拒绝，重放仍检查原能力                                                  |
| M14  | `mcp-submission.test.ts`、既有 `tasks.test.ts`：后续任务冲突回滚此前新任务、事件、快照和回执                                                |
| M15  | `mcp-consistency.test.ts`、`submission.test.ts`：北京时间跨日首次提交归新日，历史改动/重提及指定过去日期被拒                                |
| M16  | `mcp-drafts.test.ts`、`mcp-contracts.test.ts`、实际 Codex：网页更新后旧版本拒绝且无覆盖，返回当前版本及目标摘要；脚本只有新指令才使用新版本 |
| M17  | `mcp-tasks.test.ts`、`tasks.test.ts`、`archive.test.ts`：pending 初始状态及项目/任务归档约束                                                |
| M18  | `mcp-tasks.test.ts`、`mcp-consistency.test.ts`：独立状态事件、无变化结果、版本和回执，无虚构日报                                            |
| M19  | `mcp-tasks.test.ts`、`mcp-submission.test.ts`、实际 Codex：历史快照不变，公开当前任务状态变化，成员与 diary/direct、web/mcp 来源明确        |
| M20  | `mcp-consistency.test.ts`：全部 7 个写工具并发相同请求仅一次效果；`mcp-drafts.test.ts` 验证服务重启和换连接回执                             |
| M21  | `mcp-consistency.test.ts`、`mcp-sharing.test.ts`：不同参数/跨工具标识冲突，成员回执隔离，关闭链接重放不重开                                 |
| M22  | `mcp-sharing.test.ts`、`mcp-consistency.test.ts`、`mcp-contracts.test.ts`、`sharing.test.ts`：三类链接、明确日期/模块、全团队和对象投影     |
| M23  | `mcp-sharing.test.ts`、`archive.test.ts`：仅生成者关闭、重复关闭、归档撤权及恢复不重开                                                      |
| M24  | `mcp-drafts.test.ts`、`attachments.test.ts`：已有引用保留、网页文件授权沿用、无 MCP 文件字节或路径工具                                      |
| M25  | `browser/mcp.spec.ts`、`mcp-drafts.test.ts`、`mcp-contracts.test.ts`：本人成功/失败/重放及对象定位，错误码一致、私有内容不进入审计          |
| M26  | 升级脚本、`mcp-migration.test.ts`：旧资产保留、显式事件迁移、迁移失败回滚/资源释放、未来版本拒绝、恢复旧备份                                |
| M27  | `mcp-runtime.test.ts`、`mcp-auth.test.ts`：模拟可信 HTTPS 代理、Secure Cookie、Host/Origin、非本地初始化被拒、协议端点不进入 SPA            |
| M28  | 生产脚本、`mcp-runtime.test.ts`、`lifecycle.test.ts`：干净安装、仅运行依赖、限流/大小、身份隔离、初始化失败与关闭                           |
| M29  | 实际 Codex 完整流程脚本，终端版本 0.145.0；真实浏览器和匿名公开页核对，撤销后调用失败                                                       |
| M30  | 全部原接口与页面回归，包括账号、邀请、草稿、附件、提交、分享、归档及瀑布卡片                                                                |

## 验证的实际边界

测试均使用临时 SQLite、附件目录及隔离账号；实际 Codex 测试使用独立配置目录，不读取真实账号密码、不改真实团队数据。Codex 验收通过 app-server 发起真实 OAuth 与 MCP 调用，不依赖模拟 SDK。候选选择和冲突后的新处理指令由脚本明确给出，未发起模型推理；不能将服务端拒绝错误写入的证据扩展为“任何自然语言指令都会被模型正确理解”。

没有真实服务器或域名。本轮验证可信代理配置与来源约束，不等于真实 TLS 链路或公网可达性。上线仍需：提供 HTTPS 域名与证书、按精确回调登记客户端、在远程成员电脑验证连接、备份后切换服务、核对真实团队登录及公开链接。任务 10 的代码与隔离验证可以完成，真实上线保持未完成。

回退必须停止新服务并恢复匹配的旧备份和旧程序，不能让旧二进制直接写升级库。恢复旧备份会丢失备份之后的新业务和授权数据。连接、部署与恢复操作见 [MCP 手册](mcp.md)。
