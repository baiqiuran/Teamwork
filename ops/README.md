# 发布控制（实施中）

这是与业务数据库分开的主机运维入口，提供一致备份、双槽单活发布、失败恢复、本地备份保留与隔离恢复、受限 SSH 和巡检。通过真实 Linux systemd/Nginx 验收；GitHub 配置及生产接入仍待任务 11，本目录尚未安装到正式服务器。

## 操作入口

配置从 `config.example.json` 复制并绑定实际受控目录、服务与产物。控制代码、配置、状态与备份均由 root 管理，业务进程不能改写。数据、控制状态、备份与版本目录必须分开。代码包应有任务 01 的 `release.json`，配置的 `artifact` 必须与当前版本匹配。

```sh
node ops/control.mjs --config /etc/daily-flow/deploy.json backup --id before-change --kind pre-release
node ops/control.mjs --config /etc/daily-flow/deploy.json status --id before-change
node ops/control.mjs --config /etc/daily-flow/deploy.json restore --id recover-change --snapshot before-change
```

相同操作标识及参数返回已记录状态，改变参数会拒绝；失败后不会因重跑同一标识而重新覆盖数据。恢复必须明确指定快照。状态位于独立 `stateDir/operations/`，不会随着业务数据恢复而消失。

`stateDir/operation.lock` 互斥所有备份与恢复。应用服务必须使用同一个 `dataLock` 启动，例如 `ExecStart=/usr/bin/flock --nonblock /run/lock/daily-flow-data.lock /usr/local/bin/node .../build/server/main.js`，文件预先创建并归运行成员所有。维护路径必须让 Nginx worker 能遍历，并让所有业务入口返回 503 和 Retry-After；控制入口会核对真实代理响应后才停止应用。测试配置可见 `testing/backup.test.mjs`。

流程为：检查状态与恢复材料 → 维护 → systemd 停止并确认退出 → 独占数据文件锁 → 备份或恢复 → 启动及验收 → 开放。独立 `backup --kind pre-release` 只标记备份类型，仍恢复原服务；发布内部复用数据操作阶段并保持维护，不能用一个独立备份命令代替整个发布事务。

## 双槽发布

受信任上传目录内包含 `application.tar.gz`、构建的 `receipt.json`、实际基线升级验证的 `upgrade.json` 及同次验证的 `plan.json`。SHA、运行时、平台、检查清单、计划摘要和实际活动版本全部匹配后才准备候选。部署账号和传输入口的信任边界在任务 09 落实；不能接受普通成员上传的自制证明。

```sh
node ops/control.mjs --config /etc/daily-flow/deploy.json release --id release-UNIQUE --candidate /opt/daily-flow/incoming/VERIFIED --baseline FULL_DEPLOYED_SHA
```

新版本解压后，以普通运行用户在全新临时数据库中预检；该进程退出并清理后才进入维护。确认旧服务和非活动槽退出，持有相同数据锁生成一致快照，再启动另一槽。Nginx upstream 只包含活动槽的一个地址，切换过程中始终保持维护，重载后等待旧 worker 退出。开放之前持久写入 `mayHaveOpenedAt`；记录缺失或故障不能被误当作尚未接收写入。

## 失败与事故处理

开放前的启动、数据升级、代理切换或验收失败会先停止两个槽，再恢复发布前配套快照、旧代码及配置，验证后才重新开放。恢复结果为 `baseline-restored`，发布本身仍返回失败；如配套恢复失败，则保持维护、写入事故冻结，保留替换前的数据现场，不循环重试覆盖。

一旦存在可能开放的持久标记，自动路径不再恢复旧数据。开放后核验失败记录 `preserved-new-data` 并冻结后续发布；读取异常由检查入口持续统计，至少三次且跨至少60秒才进入维护，明确的数据健康错误立即维护。这里的60秒是连续失败的时间边界，不是后台定时器；后续持续巡检由任务10接入。

```sh
node ops/control.mjs --config /etc/daily-flow/deploy.json inspect --id inspection-UNIQUE
node ops/control.mjs --config /etc/daily-flow/deploy.json resolve-incident --id resolution-UNIQUE --incident EXISTING_INCIDENT_ID --expected-commit ACTUAL_SHA --note '已修复并核验当前数据与版本'
```

人工处理先修复当前代码或运行环境并保留现有数据，再明确指定事故及实际版本解除冻结。该入口重新核验本机数据、活动实例、公开版本和协议，不恢复旧快照；健康恢复或备份新鲜度恢复不会自动清除事故冻结。首次接入前的旧基线没有readiness时，配套恢复通过已验证归档、实际进程工作目录和旧协议契约核验身份；后续版本使用正式readiness。

`/health/ready` 仅公开就绪结果和提交 SHA；`/internal/health` 提供 SQLite 检查及迁移版本，须本机连接和随机健康检查凭证。Nginx 禁止该路径并移除专用头，凭证仅保存在 root 可读文件和槽位环境文件。维护标志目录必须可由 Nginx 遍历（建议独立 0755 目录），不能放进 0700 的控制状态目录。两个槽不能独立 enable；启动须使用同一 `flock`，普通应用用户仅拥有业务数据和锁文件。

应用关闭会排空已接受请求，25 秒仍未结束才断开剩余连接，之后释放数据库；systemd 使用 35 秒停止预算并确认进程已退出。启动及开放前验证共用 120 秒预算；维护通常 1～3 分钟、预算目标 10 分钟，状态记录实际耗时，超时不能并发打开生产库。网页收到 503 保留当前输入并提示稍后重试；MCP 客户端须沿用原操作 ID 重试，授权和幂等回执随同一数据库保留。

## 恢复材料与故障

每份有效快照包含数据归档、原运行产物、原 Node 二进制、单独受限的秘密配置、版本/数据时间清单和 SHA-256。备份目录权限 0700，材料 0600；配置不进入普通应用构建包或日志。SQLite 完整性与外键、附件引用、大小和指纹均校验，并重新解包归档核验文件摘要。半成品目录不接受恢复。

恢复先校验全部材料，再停止应用，恢复数据与匹配代码、配置。使用相同 Node 二进制校验，不擅自升级主机运行时；原数据改名为 `dataDir.before-restore-<id>` 保留现场。数据先在同一文件系统准备，再切换。运行产物不允许包含符号链接、硬链接或设备文件；新增依赖若需要这些类型，应先另行审查打包方式。

本地备份失败会尝试恢复原服务；如果恢复服务或明确恢复操作失败，保持维护并记录 `incident.json`。容量不足直接失败，不清理关键备份强行继续。进程被强制终止造成的锁或未完成记录必须通过重新核对入口处理，不能仅删锁后盲目重跑。

## SSH 断线与主机启动

远程调用 `dispatch.mjs` 提交持久请求，短命 SSH 命令只负责交给独立的 `daily-flow-operation-<id>.service`。systemd 持有工作进程，关闭观察窗口或取消 SSH 不结束数据操作；不要用取消 Actions 的方式停止服务器服务。`control.mjs` 是内部执行/查询入口，日常远程发布应使用 dispatch。

```sh
node ops/dispatch.mjs --config /etc/daily-flow/deploy.json release --id release-UNIQUE --candidate /opt/daily-flow/incoming/VERIFIED --baseline FULL_DEPLOYED_SHA
node ops/control.mjs --config /etc/daily-flow/deploy.json status --id release-UNIQUE
node ops/reconcile.mjs --config /etc/daily-flow/deploy.json
```

请求绑定规范参数和四份候选材料的摘要，同标识不同内容拒绝。重发相同请求返回原状态；不会重复执行已完成、已恢复或失败操作。已排队材料在执行前再次校验。没有操作回执且工作服务已失效时，查询显示未知而不伪报成功。

操作锁保存 PID、进程启动标识及开机标识，避免把复用 PID 误当作原工作进程。核对入口不打断仍活着的持锁进程；确认原进程消失后先停止它所属的 systemd 工作组，再处理遗留状态。开放前且已验证备份的激活中断恢复旧版；可能开放之后一律保留数据、维护并冻结，等待明确人工处理。正在恢复的数据阶段或损坏记录不猜测、不重复迁移。未完成操作也会阻止新操作绕过核对。

应用槽的 `ExecStartPre` 核验 root 保存的数据所有者许可及开机标识，非活动槽不能因人为启动或自动重启夺取数据。新开机必须由 `daily-flow-reconcile.service` 核对并重新签发许可，两个槽不单独 enable；实际数据库锁仍是第二道互斥。首次生产安装及重启顺序绑定在任务11执行。

`systemd/daily-flow-backup.timer` 安排北京时间每日 04:00，调用相同控制入口，服务使用无限启动时间以免在处理数据时被固定作业超时杀死。实际替换现有生产备份脚本与定时器留到首次接入阶段，避免两套备份流程交错启停应用。

## 隔离 Linux 验收

`testing/Dockerfile` 仅用于本地/CI 验证主机，不改变生产打包方式。测试需要独立 systemd 容器、真实 Nginx、已验证的 Linux 运行包；不要对正式服务器运行测试。

```sh
docker build -t daily-flow-systemd-test:local -f ops/testing/Dockerfile ops/testing
docker run -d --name daily-flow-systemd-validation --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock --mount type=bind,source=/absolute/repository,target=/repository,readonly daily-flow-systemd-test:local
docker cp /path/to/verified-artifact daily-flow-systemd-validation:/fixture-artifact
docker exec daily-flow-systemd-validation sh -lc 'mkdir /fixture-runtime && tar -xzf /fixture-artifact/application.tar.gz -C /fixture-runtime'
docker exec -w /repository daily-flow-systemd-validation node --test ops/testing/backup.test.mjs
```

特权仅用于隔离容器里的 systemd/cgroup 验收。测试应用以 `nobody` 运行，使用合成团队、日报和附件，检查完整恢复、真实入口维护、并发互斥、坏附件、损坏归档和磁盘容量门槛。调试数据保留在容器中，停止并移除该测试容器可一并清理。

## 本地备份与新鲜度（任务 07）

2026-09-20 用户取消云备份。部署配置使用 `backupMode: local`，删除 `oss` 配置，不安装或启动 `daily-flow-upload.timer`，无需 OSS/RAM 或 AccessKey。旧云配置的兼容代码仍保留，当前部署流程不调用它。

每日北京时间 04:00 备份，发布前另做一致快照。完整快照包含数据库、WAL/SHM、附件、匹配应用包、Node 和受限配置。维护、停止写入、校验、恢复服务沿用共同操作锁。发布在候选准备前和进入维护前检查最近本地快照；没有有效副本、摘要损坏或数据时间超过 24 小时，拒绝新发布，现有服务继续运行。复制旧文件不会刷新数据时间。

```sh
node ops/backup-cli.mjs --config /etc/daily-flow/deploy.json status
node ops/dispatch.mjs --config /etc/daily-flow/deploy.json backup --id daily-UNIQUE --kind daily
```

## 保留与本地副本恢复（任务 08）

本机保留七天每日备份及最近一次发布前备份，最后有效恢复点与正在恢复的材料受保护。快照自带匹配代码、Node、配置。清理与发布共用操作锁，清理前重新检查将保留的最新材料；损坏则停止，不能为了腾空间删除保护点。手工备份不自动按日/发布次数删除。

```sh
node ops/backup-cli.mjs --config /etc/daily-flow/deploy.json retention-plan
node ops/backup-cli.mjs --config /etc/daily-flow/deploy.json retention-apply
```

每月在运维控制的隔离 Linux 环境演练，真实备份不得进入 GitHub runner。步骤：

1. 在生产控制锁无活动时，暂停清理 timer，将选定的完整快照目录复制到受限运维目录，复制前后核对全部摘要，再恢复清理 timer。备份目录及副本 0700、材料 0600，不能把秘密配置放公共仓库。
2. 在独立环境安装同版本 Node、控制程序与 systemd/Nginx。准备对应的空数据/备份/版本路径和运行用户；入口仅回环监听。设置 `backupMode: local`、`recoveryMode: isolated`，不接正式流量。数据库路径、端口和槽位与快照中的运行配置保持对应。
3. 将完整副本放在 `/root/recovery-materials/SNAPSHOT_ID`，执行导入、配套恢复和业务核验：

```sh
node ops/backup-cli.mjs --config /etc/daily-flow/recovery.json import SNAPSHOT_ID --source /root/recovery-materials/SNAPSHOT_ID
node ops/control.mjs --config /etc/daily-flow/recovery.json restore --id restore-UNIQUE --snapshot SNAPSHOT_ID
node ops/backup-cli.mjs --config /etc/daily-flow/recovery.json drill-verify SNAPSHOT_ID
```

4. 核验团队、成员、日报、项目、任务、分享、附件、会话、授权及回执，比较附件字节和网页/MCP/OAuth 协议。报告位于 `stateDir/drills/SNAPSHOT_ID.json`。将报告带回生产受信任运维目录，再登记：

```sh
node ops/record-drill.mjs --config /etc/daily-flow/deploy.json --report /root/recovery-evidence.json
```

恢复报告绑定本地快照摘要与代码版本；只含校验结果、数量及耗时。保留成功与失败记录供巡检检查。若公网 origin 是 HTTPS，隔离配置设置 `recoveryPublicUrl` 为原地址，代理保留 Host，仍只监听回环。

备份保全前提下，以 24 小时恢复点、4 小时恢复耗时作为演练目标。**同机备份不覆盖服务器或磁盘全部丢失**，不再承诺整机灾难恢复。导入失败不会覆盖既有快照；发生落盘后回执中断时先保留目录并人工核验，不删除旧恢复点盲目重试。

## GitHub 串接与受限 SSH（任务 09）

仓库变量 `DEPLOY_ENABLED` 默认不存在（关闭），主机 `automationEnabled` 默认 false；首次生产验收前均不打开。生产 Environment 名为 `production`，只允许 main，Secrets 仅含 `DEPLOY_SSH_KEY`、`DEPLOY_KNOWN_HOSTS`，变量设 `DEPLOY_HOST`、`DEPLOY_USER`。必须经已可信 SSH/控制台核对服务器 host key 后保存，工作流不使用 ssh-keyscan 临时信任远端，也不使用 root 登录或旧密码。

运维以 root 安装本目录至 `/opt/daily-flow/control/ops`，依赖单独 npm ci；复制 `ssh-entry.sh` 为 `/usr/local/sbin/daily-flow-ssh-entry`，root:root 0755。新建只有 SSH 公钥的部署用户 `daily-deploy`。sudoers 只允许 `daily-deploy ALL=(root) NOPASSWD: /usr/local/sbin/daily-flow-ssh-entry`。其 authorized_keys 使用以下强制命令前缀后接 CI 公钥：

```text
command="sudo -n /usr/local/sbin/daily-flow-ssh-entry \"$SSH_ORIGINAL_COMMAND\"",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 REPLACE_PUBLIC_KEY
```

`gateway.mjs` 只接收 baseline、status ID、upload ID SHA256、release ID BASELINE。上传经标准输入，只接受四份固定名称文件，限制压缩/展开空间、核对摘要并保存 root 所有的固定材料；不能指定路径、执行 shell、读取秘密配置或替换高权限控制程序。配置中的 root 管理 bare repository 固定 origin 为本仓库，发布前 fetch main 并核对候选祖先关系。系统控制程序升级另走运维审查，普通应用发布不覆盖它。

流水线先按 main 的提交关系选最新成功的 `Application checks` push 作业，完整工作流成功才算合格（包含 `Verified Linux artifact` 和 `Linux release and recovery`）。重复请求先查询稳定操作 ID；已上传、已受理及已完成可接续，不重新迁移。实际生产基线改变则重新选取并验证；当前发布完成后再选择最新合格 main。GitHub concurrency 使用不取消运行中的作业；pending 替换顺序不当作版本顺序，服务器独立 systemd 作业也不受观察端取消影响。报告区分实际上线、开放前恢复、开放后需人工处理及本地恢复点状态。

分支规则：main 禁止直接推送/强推/删除，Require pull request，必需上述两个检查、要求分支最新；允许本人合并，不强制第二审核人。GitHub 应用/管理员绕过需关闭或单独受控。PR/普通构建无生产 Secrets，`workflow_run` 只处理本仓库 main push；部署脚本取默认分支，不执行 PR 分支部署代码。规则与邮件实际生效待任务11核验。

迁移说明存于 `docs/migrations/automatic.json`，以 `git hash-object <文件>` 得到的精确文件 blob 为键，包含 automatic、kind 和具体说明。这样 PR 可在同一提交包含说明，无需猜未来合并 SHA。每个跨度中的持久化文件版本都必须有已审阅说明，说明缺失、未说明的删除及破坏性操作会停止自动发布。纯文件搬迁须另以 `moved:<旧文件 blob>` 登记 replacement 路径和 replacementBlob；生成及验收两处核对实际父提交旧文件与目标提交新文件，目标文件也需单独说明。存在不同父版本的歧义则停止。当前登记健康检查及从线上 8d08b2b 开始的历史 DDD 搬迁、类型导入和 Codex 回调变更，未把未知版本默认为可升级。`create-plan.mjs` 生成逐提交计划后，仍执行实际基线数据升级与匹配恢复验证。

CI 在无生产资料的临时 Linux 环境构建同一固定产物，再启动真实 systemd/Nginx/SSH 隔离容器跑 `ops/testing/*.test.mjs`；新增验收文件自动纳入门槛。首次上云前也应在本地执行该入口，并核对生产旧版的单实例接入与初始备份。

## 小时巡检和通知（任务 10）

`Production inspection` 每小时 UTC 的第 17 分钟运行，独立于发布队列，不取消已受理发布。生产 Environment 增加 `DEPLOY_URL`（完整 HTTPS origin，无结尾斜线）；仓库变量 `INSPECTION_ENABLED=true` 才启用。部署账号增加的固定命令仅为 `inspect ID`、`inspection-complete ID`、`external-failure ID`、`external-ready ID`、`external-protocol-failure ID`。主机诊断包含当前版本/槽位、维护和事故、本地备份数据时间、完整性、可用磁盘、证书到期时间、续期/备份/清理 timer，以及最近恢复演练。业务正文和令牌不进入报告。

```sh
node ops/monitor.mjs --config /etc/daily-flow/deploy.json inspect manual-UNIQUE
systemctl list-timers daily-flow-backup.timer daily-flow-retention.timer snap.certbot.renew.timer
```

配置 `certificateFile` 指向实际公开证书，`renewalTimer` 指向已有续期 timer，示例的 snap 名称需以服务器实时输出为准。证书少于 6 小时、timer 停止或最近任务失败会报警；不改动证书策略。新证书仍由 GitHub 外部 HTTPS 请求核验信任、主机名及有效期。`monitorTimers` 仅供受信任主机配置指定等效 timer，本地模式默认检查备份与清理两项日序 timer，不能用空配置绕过生产交接核对。

主机使用既有 `control inspect` 和共同操作锁验证协议/数据。活动操作短暂维护时等待最多约 10 分钟，不与发布争抢数据；锁对应进程失效、未完成状态不明、预算超时均报告人工核对。服务失败时隔 31 秒复查两次，沿用至少三次且跨 60 秒的门槛；明确数据异常立即维护。根因修复后仍需 `resolve-incident` 明确解除事故冻结，不能用“重新跑巡检”或删除锁代替。

报告区分应用健康与备份状态。`LOCAL_BACKUP_STALE` 表示本地快照缺失/超龄，`BACKUP_INVALID` 表示材料无法验证；它们阻止新发布但不覆盖现有业务数据。补做有效本地备份后新鲜度门槛恢复；事故冻结仍须明确解除。

主机诊断和外部 HTTPS/readiness/login/MCP/OAuth 全部成功后才记录 `last-inspection-success.json`；匿名 MCP 返回 401、空 OAuth 请求返回 400 是预期结果。失败报告保存在 `latest-inspection.json`，成功时间不会被失败覆盖。最近的本地备份时间和恢复演练时间分别显示；演练超过 31 天、失败或超出恢复目标会报告。隔离演练失败报告也可经 `record-drill.mjs` 导入，保留此前 `last-drill-success.json`。

原生失败邮件的启用与验证：

1. 负责人进入个人 Settings → Notifications → Actions，启用 Email，可选择仅失败通知；确认邮箱已验证。
2. Actions → Production inspection → Run workflow，选择 `verify_notification=true`。这只制造一条明确的失败记录，不连接或修改服务器。实际收件后登记作业链接、触发账号、邮箱确认时间；随后正常手动运行，确认绿灯。
3. [GitHub 通知规则](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs)说明，本人触发作业通知发给本人；定时作业通知通常发给最初创建者，修改 cron 或重新启用工作流会改变通知接收者。负责人的实际定时失败收件仍须任务 11 验证，不能用“订阅仓库”或手动作业收件代替。
4. 每周核对 Actions 中最近 `Production inspection` 的 schedule 运行和服务器最后成功时间。超过两小时没有运行记录时，检查工作流是否 Disabled、`INSPECTION_ENABLED`、生产 Environment/Secrets、Actions 额度与服务状态；明确启用工作流并手动运行一次，再等待下一次 schedule 验证。

[GitHub 调度限制](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)：高负载可延迟或丢弃定时作业，公开仓库 60 天无活动可停用。只在默认分支运行，错开整点能降低拥堵，不能保证实时告警；当调度器本身停止时不会凭空产生失败邮件，需上述人工检查。首版没有独立实时监控服务。

公网检查独立执行，备份或演练告警不会跳过 HTTPS/协议探测。外部故障通过受限命令记录到独立的 `external-availability.json`，不被主机健康结果清零；同一个观测 ID 重试不重复计数，三次且跨至少 60 秒进入维护，保留当前数据并冻结后续发布。成功时间登记共用操作锁；与发布发生竞争或版本改变时重新取样，避免把正常切换误判为状态损坏。人工解除事故后重新开始计数。

外部 readiness 与其他协议分别取样：readiness 恢复会独立清零连续失败计数，即使备份告警或事故冻结仍存在；这不代表自动解冻。仅 OAuth/其他协议异常会告警并冻结新发布，不计作 readiness 不可用而关闭全站。带活动操作标记的观察不用于判断外部故障，避免维护中的预期 503 产生事故。
