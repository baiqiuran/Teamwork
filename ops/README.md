# 发布控制（实施中）

这是与业务数据库分开的主机运维入口，提供一致备份、双槽单活发布、失败恢复、OSS 补传与保留、受限 SSH 和巡检。通过真实 Linux systemd/Nginx 验收；真实 OSS、GitHub 配置及生产接入仍待任务 11，本目录尚未安装到正式服务器。

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

## OSS 上传与新鲜度（任务 07）

控制工具有独立依赖锁：在 `ops/` 执行 `npm ci --omit=dev`。这些依赖由运维安装，不随应用包替换。配置 `oss` 的 bucket、不同于 ECS 的中国内地 region、单层 prefix 与实例 roleName。桶须私有，开启公共访问阻止和默认 AES256 加密；上传额外指定私有 ACL 与 AES256，下载核验加密响应及逐文件 SHA256。采用 HTTPS、V4 签名、仅 ECS RAM 角色和 IMDSv2，不读取 CI AccessKey。

角色最小权限模板见 `oss-policy.example.json`；替换桶名并保持配置前缀一致，只关联目标 ECS。正式桶/角色/网络访问尚未实测，任务 11 才能登记真实证明。凭证接法依据 [阿里云 OSS 官方 SDK 文档](https://help.aliyun.com/zh/oss/developer-reference/nodejs-sdk/)，SDK 与凭证库版本分别锁定 6.23.0 / 2.4.7。

每次本地快照验证后，数据工作进程会先持久化 `uploads/<id>.json` 再允许启动。上传单独由 timer 执行，不延长当前维护窗口：

```sh
node ops/offsite-cli.mjs --config /etc/daily-flow/deploy.json upload
node ops/offsite-cli.mjs --config /etc/daily-flow/deploy.json status
```

`pending → uploading → verified/failed`；失败按 1、2、4…分钟重试，上限一小时，进程中断的 uploading 会继续处理相同快照。远端 complete.json 最后写入；所有材料与清单读回校验后才标记 verified。应用发布成功与备份失败分别记录，上传失败不会恢复旧数据库。首次启用自动发布前先执行一次每日备份和上传，取得有效异地副本；release 入口在准备前和维护前均检查该副本，缺失或数据时间超过 24 小时拒绝新发布。既有网页、备份和补传继续运行。

隔离测试通过 Node 模块 hook 替换 OSS I/O，覆盖离线、摘要错误、补传重启和新鲜度；没有在生产配置中加入跳过门槛开关。真实资源验证入口是上面的 backup/upload/status 组合，先使用独立测试桶和合成数据，勿把业务备份放入 GitHub runner。

上传扫描会对账已完整落盘的快照，补建因进程中断缺失的任务；原子首次发布队列记录避免并发对账覆盖已验证结果。发布完成与状态查询关联本次快照的实时 pending/failed/verified，失败退避从该次失败时刻起计算。

## 保留与异地恢复（任务 08）

`retention-plan` 只生成计划，`retention-apply` 使用与发布/备份/恢复相同的操作锁执行。每日备份本机七天、OSS 三十天；发布前备份本机最近一次、OSS 最近十次。待上传、上传失败、无队列证明、恢复中的快照，以及本地/异地最后一个有效恢复点不删除。每份快照自带应用包、Node、配置，无跨快照共享材料；清理整份目录并保留仍被引用材料清单，不清理活动 releases 或事故现场。空间不足停止操作，不能删保护点换空间。

```sh
node ops/offsite-cli.mjs --config /etc/daily-flow/deploy.json retention-plan
node ops/offsite-cli.mjs --config /etc/daily-flow/deploy.json retention-apply
```

异地拉取与清理还使用 OSS `snapshots/coordination/lock.json` 排他锁。恢复者先写 `restore-pin-*.json`，验证完成才删除；远端清理见到 pin 会保留。锁不会按时间自动过期，防止慢恢复时误清理。进程崩溃遗留锁必须由运维确认原工作进程停止、相关恢复点已保护后，再手动清除；不要把删锁当作常规重试。

每月在运维控制的隔离 Linux 主机执行以下演练（禁止在生产运行；真实材料不能进入 GitHub runner）：

1. 从独立运维存档安装相同 Node 二进制、控制程序及锁定依赖；安装 systemd/Nginx、服务用户和数据锁。准备同路径的空数据、备份、版本目录；绑定独立配置与**仅回环监听**的代理。`recoveryMode` 设置为 `isolated`。源配置中的数据库绝对路径及槽位/端口必须保持对应，跨域名/端口正式切换另作基础设施维护。
2. 给恢复主机关联受限恢复角色。配置相同私有桶及前缀，关闭应用、备份和清理定时器，勿把恢复机接入正式流量。
3. 用明确的快照 ID 拉取。完成标记、清单和全部材料逐一核验，缺失则保留失败证据并停止。下载包含秘密配置，目标目录 0700、文件 0600。

```sh
node ops/offsite-cli.mjs --config /etc/daily-flow/recovery.json pull SNAPSHOT_ID
node ops/control.mjs --config /etc/daily-flow/recovery.json restore --id restore-UNIQUE --snapshot SNAPSHOT_ID
node ops/offsite-cli.mjs --config /etc/daily-flow/recovery.json drill-verify SNAPSHOT_ID
```

4. `drill-verify` 比较团队、成员、日报、项目、任务、分享、附件、会话、授权和回执的恢复内容，校验附件字节及网页/MCP/OAuth协议；报告只包含校验结果、数量和耗时，不输出业务正文或凭证。RPO目标24小时、RTO目标4小时，实际值与是否达标分别记录在 `stateDir/drills/<id>.json`。失败/缺失材料会留存阶段及失败记录。
5. 人工核对隔离主机与报告后，把报告文件通过运维通道带回生产控制主机，用 `node ops/record-drill.mjs --config /etc/daily-flow/deploy.json --report /root/isolated-drill.json` 登记。入口核对源快照摘要与时间，供后续巡检识别月度演练过期。报告导入需要可信运维身份；文件本身不构成远程主机的密码学证明。
6. 实际整机故障恢复按同样过程先在隔离入口验证，再由运维核对公开地址、OAuth资源、证书和代理后开放。恢复的是快照生成时的数据，不能把旧快照恢复进仍接受写入的生产实例。

当前证据为真实 Linux/systemd/Nginx 加合成对象存储的完整恢复；真实 OSS 桶及独立云主机恢复留待任务11，未据此声明已达到生产 RPO/RTO。

恢复配置可用 `recoveryPublicUrl` 指定快照原来的 HTTPS 源地址：网络连接仍只去 `ingressUrl` 的回环地址，探测 Host/OAuth origin 保持原值。该字段只允许在 `recoveryMode: isolated` 且入口回环时使用。代理须保留传入 Host；不要为了演练改写授权资源地址。公网配置快照已加入隔离回归。

清理执行前会重新验证将保留的本地和异地最新恢复点的四份完整材料摘要，任何缺失/不符都停止全部清理，保留更旧恢复点。下载已落盘但 fetched 回执丢失时，重新拉取会核对已有目录的摘要与完整性后补齐回执；不同内容拒绝覆盖。

OSS 桶须从未启用版本控制，SDK 会检查并拒绝 Enabled/Suspended。原因是 [PutObject 官方说明](https://help.aliyun.com/en/oss/developer-reference/putobject) 明确：版本控制开启或暂停时 `x-oss-forbid-overwrite` 无效，不能据此建立排他锁。角色增加只读 `GetBucketVersioning` 权限；此版本也不通过删除标记伪装成历史版本已按期清理。

## GitHub 串接与受限 SSH（任务 09）

仓库变量 `DEPLOY_ENABLED` 默认不存在（关闭），主机 `automationEnabled` 默认 false；首次生产验收前均不打开。生产 Environment 名为 `production`，只允许 main，Secrets 仅含 `DEPLOY_SSH_KEY`、`DEPLOY_KNOWN_HOSTS`，变量设 `DEPLOY_HOST`、`DEPLOY_USER`。必须经已可信 SSH/控制台核对服务器 host key 后保存，工作流不使用 ssh-keyscan 临时信任远端，也不使用 root 登录或旧密码。

运维以 root 安装本目录至 `/opt/daily-flow/control/ops`，依赖单独 npm ci；复制 `ssh-entry.sh` 为 `/usr/local/sbin/daily-flow-ssh-entry`，root:root 0755。新建只有 SSH 公钥的部署用户 `daily-deploy`。sudoers 只允许 `daily-deploy ALL=(root) NOPASSWD: /usr/local/sbin/daily-flow-ssh-entry`。其 authorized_keys 使用以下强制命令前缀后接 CI 公钥：

```text
command="sudo -n /usr/local/sbin/daily-flow-ssh-entry \"$SSH_ORIGINAL_COMMAND\"",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 REPLACE_PUBLIC_KEY
```

`gateway.mjs` 只接收 baseline、status ID、upload ID SHA256、release ID BASELINE。上传经标准输入，只接受四份固定名称文件，限制压缩/展开空间、核对摘要并保存 root 所有的固定材料；不能指定路径、执行 shell、读取秘密配置或替换高权限控制程序。配置中的 root 管理 bare repository 固定 origin 为本仓库，发布前 fetch main 并核对候选祖先关系。系统控制程序升级另走运维审查，普通应用发布不覆盖它。

流水线先按 main 的提交关系选最新成功的 `Application checks` push 作业，完整工作流成功才算合格（包含 `Verified Linux artifact` 和 `Linux release and recovery`）。重复请求先查询稳定操作 ID；已上传、已受理及已完成可接续，不重新迁移。实际生产基线改变则重新选取并验证；当前发布完成后再选择最新合格 main。GitHub concurrency 使用不取消运行中的作业；pending 替换顺序不当作版本顺序，服务器独立 systemd 作业也不受观察端取消影响。报告区分实际上线、开放前恢复、开放后需人工处理及异地备份待补传。

分支规则：main 禁止直接推送/强推/删除，Require pull request，必需上述两个检查、要求分支最新；允许本人合并，不强制第二审核人。GitHub 应用/管理员绕过需关闭或单独受控。PR/普通构建无生产 Secrets，`workflow_run` 只处理本仓库 main push；部署脚本取默认分支，不执行 PR 分支部署代码。规则与邮件实际生效待任务11核验。

迁移说明存于 `docs/migrations/automatic.json`，以 `git hash-object <文件>` 得到的精确文件 blob 为键，包含 automatic、kind 和具体说明。这样 PR 可在同一提交包含说明，无需猜未来合并 SHA。每个跨度中的持久化文件版本都必须有已审阅说明，缺失/删除/破坏性操作会停止自动发布。当前仅登记本轮已审阅的健康检查变更，不把更早未核对的线上版本默认为可自动升级。`create-plan.mjs` 生成逐提交计划后，仍执行实际基线数据升级与匹配恢复验证。

CI 在无生产资料的临时 Linux 环境构建同一固定产物，再启动真实 systemd/Nginx/SSH 隔离容器跑 `ops/testing/*.test.mjs`；新增验收文件自动纳入门槛。首次上云前也应在本地执行该入口，并核对生产旧版的单实例接入与初始备份。

## 小时巡检和通知（任务 10）

`Production inspection` 每小时 UTC 的第 17 分钟运行，独立于发布队列，不取消已受理发布。生产 Environment 增加 `DEPLOY_URL`（完整 HTTPS origin，无结尾斜线）；仓库变量 `INSPECTION_ENABLED=true` 才启用。部署账号增加的固定命令仅为 `inspect ID`、`inspection-complete ID`。主机诊断包含当前版本/槽位、维护和事故、备份数据时间、失败补传、可用磁盘、证书到期时间、续期/备份/补传/清理 timer，以及最近恢复演练。业务正文和令牌不进入报告。

```sh
node ops/monitor.mjs --config /etc/daily-flow/deploy.json inspect manual-UNIQUE
systemctl list-timers daily-flow-backup.timer daily-flow-upload.timer daily-flow-retention.timer snap.certbot.renew.timer
```

配置 `certificateFile` 指向实际公开证书，`renewalTimer` 指向已有续期 timer，示例的 snap 名称需以服务器实时输出为准。证书少于 6 小时、timer 停止或最近任务失败会报警；不改动证书策略。新证书仍由 GitHub 外部 HTTPS 请求核验信任、主机名及有效期。`monitorTimers` 仅供受信任主机配置指定等效 timer，默认检查三项日序 timer，不能用空配置绕过生产交接核对。

主机使用既有 `control inspect` 和共同操作锁验证协议/数据。活动操作短暂维护时等待最多约 10 分钟，不与发布争抢数据；锁对应进程失效、未完成状态不明、预算超时均报告人工核对。服务失败时隔 31 秒复查两次，沿用至少三次且跨 60 秒的门槛；明确数据异常立即维护。根因修复后仍需 `resolve-incident` 明确解除事故冻结，不能用“重新跑巡检”或删除锁代替。

报告要区分：`publicService.healthy=true` 且 `backup.pending>0` 表示应用正常、正在补传；`OFFSITE_UPLOAD_FAILED` 表示上传异常；`OFFSITE_BACKUP_STALE` 使发布门槛暂时不满足，网页仍服务，补传成功后门槛自动恢复。二者不会自动恢复旧数据，也不会自己清除既有事故冻结。磁盘不足先扩容或按保留规则清理非保护材料，不能删除未上传备份。

主机诊断和外部 HTTPS/readiness/login/MCP/OAuth 全部成功后才记录 `last-inspection-success.json`；匿名 MCP 返回 401、空 OAuth 请求返回 400 是预期结果。失败报告保存在 `latest-inspection.json`，成功时间不会被失败覆盖。最近的异地备份时间和恢复演练时间分别显示；演练超过 31 天、失败或超出恢复目标会报告。隔离演练失败报告也可经 `record-drill.mjs` 导入，保留此前 `last-drill-success.json`。

原生失败邮件的启用与验证：

1. 负责人进入个人 Settings → Notifications → Actions，启用 Email，可选择仅失败通知；确认邮箱已验证。
2. Actions → Production inspection → Run workflow，选择 `verify_notification=true`。这只制造一条明确的失败记录，不连接或修改服务器。实际收件后登记作业链接、触发账号、邮箱确认时间；随后正常手动运行，确认绿灯。
3. [GitHub 通知规则](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs)说明，本人触发作业通知发给本人；定时作业通知通常发给最初创建者，修改 cron 或重新启用工作流会改变通知接收者。负责人的实际定时失败收件仍须任务 11 验证，不能用“订阅仓库”或手动作业收件代替。
4. 每周核对 Actions 中最近 `Production inspection` 的 schedule 运行和服务器最后成功时间。超过两小时没有运行记录时，检查工作流是否 Disabled、`INSPECTION_ENABLED`、生产 Environment/Secrets、Actions 额度与服务状态；明确启用工作流并手动运行一次，再等待下一次 schedule 验证。

[GitHub 调度限制](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)：高负载可延迟或丢弃定时作业，公开仓库 60 天无活动可停用。只在默认分支运行，错开整点能降低拥堵，不能保证实时告警；当调度器本身停止时不会凭空产生失败邮件，需上述人工检查。首版没有独立实时监控服务。
