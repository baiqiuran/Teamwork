# 发布控制（实施中）

这是与业务数据库分开的主机运维入口。目前提供任务 03 的一致备份、查询与配套恢复，使用真实 Linux systemd/Nginx 验收。双槽发布、阶段恢复、断线接管、OSS 和生产接入由后续任务接入；本目录尚未安装到正式服务器。

## 操作入口

配置从 `config.example.json` 复制并绑定实际受控目录、服务与产物。控制代码、配置、状态与备份均由 root 管理，业务进程不能改写。数据、控制状态、备份与版本目录必须分开。代码包应有任务 01 的 `release.json`，配置的 `artifact` 必须与当前版本匹配。

```sh
node ops/control.mjs --config /etc/daily-flow/deploy.json backup --id before-change --kind pre-release
node ops/control.mjs --config /etc/daily-flow/deploy.json status --id before-change
node ops/control.mjs --config /etc/daily-flow/deploy.json restore --id recover-change --snapshot before-change
```

相同操作标识及参数返回已记录状态，改变参数会拒绝；失败后不会因重跑同一标识而重新覆盖数据。恢复必须明确指定快照。状态位于独立 `stateDir/operations/`，不会随着业务数据恢复而消失。

`stateDir/operation.lock` 互斥所有备份与恢复。应用服务必须使用同一个 `dataLock` 启动，例如 `ExecStart=/usr/bin/flock --nonblock /run/lock/daily-flow-data.lock /usr/local/bin/node .../build/server/main.js`，文件预先创建并归运行成员所有。维护路径必须让 Nginx worker 能遍历，并让所有业务入口返回 503 和 Retry-After；控制入口会核对真实代理响应后才停止应用。测试配置可见 `testing/backup.test.mjs`。

流程为：检查状态与恢复材料 → 维护 → systemd 停止并确认退出 → 独占数据文件锁 → 备份或恢复 → 启动及验收 → 开放。当前任务的 `pre-release` 只标记备份类型，仍恢复原服务；发布内部持续维护的调用会在任务 04 复用数据操作阶段，不能用一个独立备份命令代替整个发布事务。

## 恢复材料与故障

每份有效快照包含数据归档、原运行产物、原 Node 二进制、单独受限的秘密配置、版本/数据时间清单和 SHA-256。备份目录权限 0700，材料 0600；配置不进入普通应用构建包或日志。SQLite 完整性与外键、附件引用、大小和指纹均校验，并重新解包归档核验文件摘要。半成品目录不接受恢复。

恢复先校验全部材料，再停止应用，恢复数据与匹配代码、配置。使用相同 Node 二进制校验，不擅自升级主机运行时；原数据改名为 `dataDir.before-restore-<id>` 保留现场。数据先在同一文件系统准备，再切换。运行产物不允许包含符号链接、硬链接或设备文件；新增依赖若需要这些类型，应先另行审查打包方式。

本地备份失败会尝试恢复原服务；如果恢复服务或明确恢复操作失败，保持维护并记录 `incident.json`。容量不足直接失败，不清理关键备份强行继续。任务 06 完成前，进程被强制终止造成的锁或未完成记录需要人工核对，不能仅删锁后盲目重跑。

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
