# 日序 CI/CD：生产接入与运维手册

这是从现有单实例接入自动发布的操作手册。**当前尚未完成生产接入，不能据此认为 本地备份接入、自动发布或通知已经生效。** 控制程序的安装与第一次切换属于基础设施维护，后续 PR 发布只更新普通应用。

## 已核对的生产现场

2026-09-20 首次通过已验证 SSH 主机身份只读检查（下表是准备前快照）：

| 项目 | 实测结果 |
| --- | --- |
| 地址 | `https://8.148.245.224`，仍使用公网 IP |
| 当前代码 | `8d08b2b959c7067e2125b7446681fb730a8c45a6`；已跟踪源码无修改 |
| 当前服务 | `daily-flow.service` active，普通用户 `daily-flow`，端口 4310 |
| Node | `v24.15.0` |
| 数据库 | `/var/lib/daily-flow/daily-flow.sqlite`，附件在同目录下 |
| 数据与空间 | 数据目录约 236 KB；原备份约 52 KB；根盘可用约 32 GB |
| 内存 | 约 1.7 GB，另有 1 GB swap；构建放 GitHub runner |
| 旧备份 | 每日 04:00，`/etc/daily-flow/backup.sh`；最近任务成功 |
| 证书 | 当前证书到期 `2026-09-24 18:39:44 UTC`；`snap.certbot.renew.timer` 正常、最近续期任务成功 |
| 新控制程序 | `/opt/daily-flow/control`、新控制状态及 `deploy.json` 尚未安装 |
| 备份方案 | 2026-09-20 用户取消云备份，采用服务器本地备份；无需 OSS/RAM |

这些是首次检查时的快照，实施切换前必须再核对。

同日后续已完成准备：控制程序 42171fa 安装到 `/opt/daily-flow/control/ops`，配置采用 `backupMode: local`、实际数据库名 `daily-flow.sqlite`；独立 `daily-deploy` 强制 SSH 命令、受限 sudo 与 GitHub production 两项 Secrets 已配置。主机指纹已核验，任意 shell 读取命令被拒绝。运行状态尚未登记，`baseline` 暂不能作为已接入验收。

旧运行材料封存为 `/opt/daily-flow/artifacts/legacy-8d08b2b/application.tar.gz`，摘要 `18d09eaf2ada65ffded6e7ec97bc339b4b66d6e811307b34d976ba70cbed67b6`，明确标为 legacy 材料而非 CI 产物。新控制器使用 `/opt/daily-flow/managed-current`；blue 链接、环境、健康凭证和数据锁 tmpfiles 已准备，两个槽位均未启动。原配置的受限副本在 `/root/daily-flow-before-managed`。

旧 `daily-flow.service` 与原备份 timer 仍 active，未修改 Nginx、未停止服务、未切换数据库、未改证书或初始化团队。接续安装时复用并核对这些材料，不重复覆盖配置/密钥。

## 1. 本地备份方案

无需创建 OSS 桶或 RAM 角色。配置 `backupMode: local`，不保留 `oss` 配置，不启用上传 timer。备份目录 `/var/backups/daily-flow-managed` 与业务目录分开，由 root 管理。

每日北京时间 04:00 备份；发布前额外备份；保留最近七天每日备份和最近一次发布前备份。每份包含 SQLite/WAL/SHM、附件、匹配代码、Node 与受限配置，并校验摘要、数据库和附件。初次接入先建立有效本地快照；超过 24 小时没有有效快照、材料损坏或磁盘不足时停止新发布。

同机备份无法应对服务器或磁盘全部丢失。恢复演练以备份副本仍然存在为前提，不再承诺整机灾难恢复目标。

## 2. GitHub 与部署身份

在本机运行 `gh auth login --web`，完成有仓库管理权限的账号登录。2026-09-20 已验证 `baiqiuran` 具备仓库 admin 权限；随后已建立 production Environment（仅 main）、main PR/必需检查保护及非秘密变量；发布与巡检开关均为 false。部署 Secrets 后续已安装（见上方准备记录），应用切换尚未执行。无需发送令牌。首次设置需要仓库/Environment/分支规则权限；普通 workflow token 只保留工作流中声明的只读权限。

| 位置 | 名称 | 值/来源 |
| --- | --- | --- |
| 仓库 Variable | `DEPLOY_ENABLED` | 先 `false`，验收后才开启 |
| 仓库 Variable | `INSPECTION_ENABLED` | 先 `false`，接入诊断后开启 |
| production Variable | `DEPLOY_HOST` | `8.148.245.224` |
| production Variable | `DEPLOY_USER` | 专用 `daily-deploy` |
| production Variable | `DEPLOY_URL` | `https://8.148.245.224` |
| production Secret | `DEPLOY_SSH_KEY` | 新生成的专用部署私钥 |
| production Secret | `DEPLOY_KNOWN_HOSTS` | 从可信 SSH/控制台核验的主机公钥 |

2026-09-20 实测 ED25519 主机指纹：`SHA256:oJatmlAzkijPP2Z/o28Hpy6y8qxmUkkK4ByUXSc9Hgc`。实施时再比较服务器 `/etc/ssh/ssh_host_ed25519_key.pub`，不要仅凭网络扫描信任新的主机密钥。

production Environment 只接受 main。main 要求 PR、`Verified Linux artifact` 和 `Linux release and recovery` 两项检查，分支必须最新，禁止直接推送、强推和删除；允许本人合并，不要求第二位审核人。管理员绕过也应关闭或受控。当前本地 main 上的实施提交须先推到实施分支发起 PR，**不能因本地已提交就直接把这一批代码推上生产 main**。

专用 SSH 公钥配置强制命令、禁止端口转发/代理转发/PTY，sudo 只允许 root 所有的固定 `daily-flow-ssh-entry`。完整配置见 [受限 SSH](../ops/README.md#github-串接与受限-ssh任务-09)。普通部署账号不能改控制程序、运维配置、状态目录或证书。

## 3. 首次接入：需要完成的维护步骤

以下是首次切换检查单。控制程序、部署身份、旧版运行归档及独立配置已准备；**流量/服务切换和生产验收尚未执行**。没有实测旧版恢复材料与已验证本地副本时，不开始切换。

1. 留存当前 Nginx、systemd、备份 timer 和秘密环境文件的受限运维副本；备份秘密文件只放 root 目录，不能上传 Actions。核对真实数据库大小和控制器磁盘预算。
2. 针对实际 `8d08b2b…` 到候选版本，逐提交审查持久化变更，生成明确迁移说明，运行 `verify-candidate.mjs` 的旧库升级与配套恢复。当前 CI 的固定历史基线验证不能替代真实线上基线验证。历史分支合并涉及文件移动，缺失说明时应停止并人工审查，不能把整个跨度一律标为自动安全。
3. 将当前实际运行代码、生产依赖和 Node 制成匹配的只读恢复材料，登记真实版本和文件摘要。旧部署没有新版产物证明，不能给它伪造“CI 已通过”的候选回执。完成旧版归档/恢复演练后，才登记初始 runtime。
4. 以 root 安装已审阅的 `ops/` 和独立锁定依赖到 `/opt/daily-flow/control/ops`；复制配置并填写真实路径。**数据库名必须改为 `daily-flow.sqlite`，不能照抄示例 `data.sqlite` 新建空团队。** 主机 `automationEnabled=false`。
5. 准备 blue/green 路径、0700 控制与备份目录、0755 维护标记目录、root 随机健康凭证。数据锁需通过 systemd-tmpfiles 在每次开机创建并赋给运行用户；仅手工 touch `/run/lock` 无法跨重启。
6. 在原 TLS server 中加入维护入口、禁止 `/internal/`、移除外来健康凭证头，并把 upstream 指向单一活动端口；保留原证书/ACME、Host/转发头、关闭缓冲与缓存、300 秒 MCP 超时和 28 MB 请求限制。原 `/setup` 禁止公网访问的规则继续保留。
7. 进入维护并确认网页/API/公开/MCP 入口都返回 503 与 Retry-After；停止旧备份 timer，确认旧备份服务未运行；停止并禁用旧 `daily-flow.service`，确认进程退出后才启动 blue。两个槽均不单独 enable，启动通过 owner guard 与同一个数据 flock。
8. 验证旧版在 blue 的网页/MCP/OAuth、原账号和历史内容，再执行新控制器的一致备份及本地材料校验，取得 24 小时内的有效副本。不要同时保留旧备份脚本和新控制器写库。
9. 配置 boot reconcile 和新每日备份/清理 timer，进行受控重启验收，确认单活及启动所有者。续期 timer 保持原配置。
10. 初始恢复点、实际升级证明、双槽及只读检查通过后再开启主机自动发布。随后启用 GitHub 变量，完成一次真正的 PR 合并驱动发布，记录下表；故障演练只在隔离环境进行。

| 首次真实验收证据 | 待填写 |
| --- | --- |
| PR / Actions run | |
| 实际前后 SHA、候选 SHA256 | |
| blue/green 前后槽位、维护毫秒数 | |
| 本地快照 ID、数据时间、回读校验 | |
| 原成员登录与内容核验（成员确认） | |
| 定时巡检 run、负责人实际失败邮件 | |
| 隔离环境本地副本恢复报告、RPO/RTO | |

## 4. 日常操作

接入完成后，在服务器受信任运维账户使用以下入口。操作 ID 每次新操作取唯一值；同一操作重试沿用原值。

```sh
# 查看原发布；先看 phase、actualCommit、recovery 和 offsite
node /opt/daily-flow/control/ops/control.mjs --config /etc/daily-flow/deploy.json status --id OPERATION_ID

# 生成一致备份；独立 systemd 作业执行，SSH 断开不取消
node /opt/daily-flow/control/ops/dispatch.mjs --config /etc/daily-flow/deploy.json backup --id MANUAL_BACKUP_ID --kind manual

# 查看本地恢复点与保留计划
node /opt/daily-flow/control/ops/backup-cli.mjs --config /etc/daily-flow/deploy.json status
node /opt/daily-flow/control/ops/backup-cli.mjs --config /etc/daily-flow/deploy.json retention-plan

# 状态不明或主机重启：先核对原执行者，不盲目删锁
node /opt/daily-flow/control/ops/reconcile.mjs --config /etc/daily-flow/deploy.json

# 修复当前版本/数据并完成核验后，明确解除既有事故
node /opt/daily-flow/control/ops/control.mjs --config /etc/daily-flow/deploy.json resolve-incident --id RESOLUTION_ID --incident INCIDENT_ID --expected-commit ACTUAL_SHA --note '修复内容及核验结果'
```

维护停机应先关闭入口并确认，再停止活动槽；启动经 reconcile/控制入口恢复所有者，不直接同时启动两个槽。`baseline-restored` 表示开放前已配套恢复；`preserved-new-data`/`manual-intervention` 表示必须保留现有数据。已经开放过流量时，不能把“切回旧代码”与“恢复旧数据库”当作同一个安全操作。

备份超龄只阻止新发布，新的有效本地备份完成后自动恢复这项门槛；事故冻结仍需人工核验解除。磁盘不足保留保护快照和现场，扩容或依保留计划处理其他材料。

## 5. 恢复、通知与交付边界

每月将已校验本地备份的完整副本导入运维控制的隔离 Linux 环境，验证业务、附件及授权后登记报告。命令和保护规则见 [本地副本恢复手册](../ops/README.md#保留与本地副本恢复任务-08)。真实业务备份不得进入 GitHub runner；恢复环境仅回环监听。24 小时恢复点、4 小时恢复耗时仅用于“备份仍存在”的演练，须通过实际结果验证。

通知配置与受控收件测试见 [小时巡检](../ops/README.md#小时巡检和通知任务-10)。手动作业的失败邮件与定时作业的收件对象可能不同，两者分别确认。每周检查实际 schedule 运行与最后成功时间，不能仅以配置文件存在判断巡检运行。

目前缺少首次生产切换/PR 发布、定时邮件收件和真实本地副本恢复证据，因此任务 11 保持未完成。现有线上服务继续按原方式运行。

## 本轮验证证据

代码提交 42171fa 的 PR 构建与真实 Linux 主机验收均通过：[Actions run 35497545434](https://github.com/baiqiuran/Teamwork/actions/runs/35497545434)。本地完整主机回归 27/27，通过审查后的定向回归 2/2。

真实线上源码版本 8d08b2b 编译后，对 PR 测试合并提交 00ce8ca70fbd05dfd903392d16f83c165ba52372 的原样运行包执行隔离升级与旧备份恢复，通过账号、会话、草稿、事件、公开链接、附件和授权校验。产物摘要 ffc6cc719472b257312ab6c459303b710db5ca854e14738b80ac7065adcaf1ea。此证据不等于完整历史迁移说明已审阅，也不把 PR 测试合并提交当作正式 main；首次接入仍须核对最终 main 产物。
