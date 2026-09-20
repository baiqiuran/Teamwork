# 日序 CI/CD：生产接入与运维手册

这是从现有单实例接入自动发布的操作手册。**当前尚未完成生产接入，不能据此认为 OSS、自动发布或通知已经生效。** 控制程序的安装与第一次切换属于基础设施维护，后续 PR 发布只更新普通应用。

## 已核对的生产现场

2026-09-20 通过已验证 SSH 主机身份只读检查：

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
| ECS 实例角色 | 元数据角色入口返回 404；用户确认 OSS/RAM 尚未创建 |

这些是检查时的快照，实施切换前必须再核对。当前未停止服务、未切换数据库、未改证书、未初始化团队。

## 1. 先准备云资源

在 [OSS 控制台](https://oss.console.aliyun.com/) 创建普通 Bucket，建议华东 2（上海）`cn-shanghai`，与 ECS 的广州地域分开。使用标准存储、私有读写、阻止公共访问、默认 SSE-OSS/AES256 加密。桶名全局唯一，例如自行选择 `hrteamwork-backups-<唯一后缀>`；记录实际桶名。

本控制器要求桶**从未启用版本控制**。不要先启用再暂停；它依赖禁止覆盖写实现远端恢复/清理互斥，而 OSS 在 Enabled/Suspended 下不保证该语义。首版不设置独立生命周期删除规则，以免绕过待补传、恢复中及最后有效快照的保护。相关入口见 [创建 Bucket 官方说明](https://help.aliyun.com/en/oss/user-guide/create-a-bucket-4)。

在 [RAM 控制台](https://ram.console.aliyun.com/) 的身份管理 → 角色创建 `DailyFlowBackupRole`，信任主体为云服务、云服务器 ECS。创建自定义权限策略，复制 [最小权限模板](../ops/oss-policy.example.json)，把全部 `REPLACE_BUCKET` 替换为实际桶名，保持 `snapshots/` 前缀，并关联这个角色。它只允许本桶的必要元信息和指定前缀对象操作，不授予整个 OSS 的管理权限。

在 ECS 控制台选择广州、目标实例 `8.148.245.224` → 全部操作 → 实例设置 → 授予/收回 RAM 角色，授予上述角色。官方过程及权限要求见 [实例 RAM 角色](https://help.aliyun.com/zh/ecs/user-guide/attach-an-instance-ram-role-to-an-ecs-instance)。应用通过 IMDSv2 取得短效凭证，不需要把 AccessKey 发给代理或放到 GitHub。

完成后只需提供三个普通配置值：**桶名、地域、角色名**。ECS 侧还需实际验证私有 ACL、版本控制状态、AES256 上传及回读摘要。阿里云账号的资源创建权限不能用 SSH root 权限代替。

## 2. GitHub 与部署身份

在本机运行 `gh auth login --web`，完成有仓库管理权限的账号登录。2026-09-20 已验证 `baiqiuran` 具备仓库 admin 权限；随后已建立 production Environment（仅 main）、main PR/必需检查保护及非秘密变量；发布与巡检开关均为 false。部署 Secrets 尚未安装。无需发送令牌。首次设置需要仓库/Environment/分支规则权限；普通 workflow token 只保留工作流中声明的只读权限。

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

以下是首次切换检查单，**尚未执行**。没有实测旧版恢复材料与真实 OSS 副本时，不开始切换。

1. 留存当前 Nginx、systemd、备份 timer 和秘密环境文件的受限运维副本；备份秘密文件只放 root 目录，不能上传 Actions。核对真实数据库大小和控制器磁盘预算。
2. 针对实际 `8d08b2b…` 到候选版本，逐提交审查持久化变更，生成明确迁移说明，运行 `verify-candidate.mjs` 的旧库升级与配套恢复。当前 CI 的固定历史基线验证不能替代真实线上基线验证。历史分支合并涉及文件移动，缺失说明时应停止并人工审查，不能把整个跨度一律标为自动安全。
3. 将当前实际运行代码、生产依赖和 Node 制成匹配的只读恢复材料，登记真实版本和文件摘要。旧部署没有新版产物证明，不能给它伪造“CI 已通过”的候选回执。完成旧版归档/恢复演练后，才登记初始 runtime。
4. 以 root 安装已审阅的 `ops/` 和独立锁定依赖到 `/opt/daily-flow/control/ops`；复制配置并填写真实路径。**数据库名必须改为 `daily-flow.sqlite`，不能照抄示例 `data.sqlite` 新建空团队。** 主机 `automationEnabled=false`。
5. 准备 blue/green 路径、0700 控制与备份目录、0755 维护标记目录、root 随机健康凭证。数据锁需通过 systemd-tmpfiles 在每次开机创建并赋给运行用户；仅手工 touch `/run/lock` 无法跨重启。
6. 在原 TLS server 中加入维护入口、禁止 `/internal/`、移除外来健康凭证头，并把 upstream 指向单一活动端口；保留原证书/ACME、Host/转发头、关闭缓冲与缓存、300 秒 MCP 超时和 28 MB 请求限制。原 `/setup` 禁止公网访问的规则继续保留。
7. 进入维护并确认网页/API/公开/MCP 入口都返回 503 与 Retry-After；停止旧备份 timer，确认旧备份服务未运行；停止并禁用旧 `daily-flow.service`，确认进程退出后才启动 blue。两个槽均不单独 enable，启动通过 owner guard 与同一个数据 flock。
8. 验证旧版在 blue 的网页/MCP/OAuth、原账号和历史内容，再执行新控制器的一致备份与真实 OSS 上传/回读，取得 24 小时内的有效副本。不要同时保留旧备份脚本和新控制器写库。
9. 配置 boot reconcile 和新每日备份/补传/清理 timer，进行受控重启验收，确认单活及启动所有者。续期 timer 保持原配置。
10. 初始恢复点、实际升级证明、双槽及只读检查通过后再开启主机自动发布。随后启用 GitHub 变量，完成一次真正的 PR 合并驱动发布，记录下表；故障演练只在隔离环境进行。

| 首次真实验收证据 | 待填写 |
| --- | --- |
| PR / Actions run | |
| 实际前后 SHA、候选 SHA256 | |
| blue/green 前后槽位、维护毫秒数 | |
| 本地/OSS 快照 ID、数据时间、回读校验 | |
| 原成员登录与内容核验（成员确认） | |
| 定时巡检 run、负责人实际失败邮件 | |
| 独立主机 OSS 恢复报告、RPO/RTO | |

## 4. 日常操作

接入完成后，在服务器受信任运维账户使用以下入口。操作 ID 每次新操作取唯一值；同一操作重试沿用原值。

```sh
# 查看原发布；先看 phase、actualCommit、recovery 和 offsite
node /opt/daily-flow/control/ops/control.mjs --config /etc/daily-flow/deploy.json status --id OPERATION_ID

# 生成一致备份；独立 systemd 作业执行，SSH 断开不取消
node /opt/daily-flow/control/ops/dispatch.mjs --config /etc/daily-flow/deploy.json backup --id MANUAL_BACKUP_ID --kind manual

# 查询补传、触发重试（不重新发布应用）
node /opt/daily-flow/control/ops/offsite-cli.mjs --config /etc/daily-flow/deploy.json status
node /opt/daily-flow/control/ops/offsite-cli.mjs --config /etc/daily-flow/deploy.json upload

# 状态不明或主机重启：先核对原执行者，不盲目删锁
node /opt/daily-flow/control/ops/reconcile.mjs --config /etc/daily-flow/deploy.json

# 修复当前版本/数据并完成核验后，明确解除既有事故
node /opt/daily-flow/control/ops/control.mjs --config /etc/daily-flow/deploy.json resolve-incident --id RESOLUTION_ID --incident INCIDENT_ID --expected-commit ACTUAL_SHA --note '修复内容及核验结果'
```

维护停机应先关闭入口并确认，再停止活动槽；启动经 reconcile/控制入口恢复所有者，不直接同时启动两个槽。`baseline-restored` 表示开放前已配套恢复；`preserved-new-data`/`manual-intervention` 表示必须保留现有数据。已经开放过流量时，不能把“切回旧代码”与“恢复旧数据库”当作同一个安全操作。

备份超龄只阻止新发布，成功补传后自动恢复这项门槛；事故冻结仍需人工核验解除。磁盘不足保留保护快照和现场，扩容或依保留计划处理其他材料。

## 5. 恢复、通知与交付边界

每月在运维控制的隔离 Linux 主机从 OSS 拉取完整材料，验证团队、日报、任务、分享、附件和授权，再导入报告。运行命令、保留规则和 RPO/RTO 计算见 [异地恢复手册](../ops/README.md#保留与异地恢复任务-08)。真实业务备份不得进入 GitHub runner；恢复机先仅回环监听，确认完毕后才考虑正式切换。整机目标为最多 24 小时数据、4 小时恢复，必须用真实演练证明。

通知配置与受控收件测试见 [小时巡检](../ops/README.md#小时巡检和通知任务-10)。手动作业的失败邮件与定时作业的收件对象可能不同，两者分别确认。每周检查实际 schedule 运行与最后成功时间，不能仅以配置文件存在判断巡检运行。

目前缺少真实 OSS/RAM、首次生产切换/PR 发布、定时邮件收件和独立云端恢复证据，因此任务 11 保持未完成。现有线上服务继续按原方式运行。
