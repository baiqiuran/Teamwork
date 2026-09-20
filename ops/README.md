# 发布控制（实施中）

这是与业务数据库分开的主机运维入口。目前提供一致备份、查询、配套恢复、同机双槽发布、按开放边界处理失败及独立执行/启动核对，使用真实 Linux systemd/Nginx 验收。OSS 和生产接入由后续任务接入；本目录尚未安装到正式服务器。

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
