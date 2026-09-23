# 手工发布与人工恢复

**状态：2026-09-23 已完成生产单实例接管和首次真实发布。** 当前由 `daily-flow.service` 在回环 4310 端口运行提交 `402863b909615ed0b3d74a44473dd40f11e581f3`，本机基线记录也已更新。日常发布继续使用下文的固定产物打包与发布命令；2026-09-22 的 blue 槽实测属于历史状态。

自动发布与切槽链路已不再使用。旧 `ops/`、`scripts/` 控制与测试代码保留；GitHub workflow 定义与相关 GitHub 配置已于 2026-09-22 删除。受管每日备份、保留、配套恢复仍在使用。不要删除整个 `ops/`，不要恢复 GitHub workflow 开关。

## 一次性准备

### 本机

需要 Git、GNU tar、Node，以及与生产版本完全相同的**本机平台** Node 发行包（含 npm）。Windows 系统 PATH 默认找到的 `tar.exe` 通常是 bsdtar；构建脚本会检查 GNU tar，并可从 Git for Windows 的 `usr/bin/` 选择配套的 `tar.exe` 和 `gzip.exe`。找不到 GNU tar 时在构建前明确报错。例如生产为 Linux Node v24.15.0，Windows 本机使用 Windows v24.15.0；不能在 Windows 执行 Linux 二进制。运行依赖必须为纯 JavaScript；发现 `.node`、链接或特殊文件即拒绝交付。

维护者独占密钥。私钥、known_hosts、配置、发布包和记录全部保存在**整个工作区之外**，不只是 `app/` 之外。不要在文档、截图、日志或 Git 中写真实私钥路径。新密钥在外部目录用 `ssh-keygen -t ed25519` 交互生成，必须设置口令；用操作系统 ACL 取消继承，只允许本人访问，核对没有其他普通用户/组读取权限。生成和调整权限是维护者的一次性操作，不由发布脚本执行。口令通过 `ssh-add` 交互输入，脚本只使用已加载的 agent，不读取口令。

主机公钥必须从阿里云控制台或已有可信渠道核验后写入外部 known_hosts。实测 ED25519 指纹为 `SHA256:oJatmlAzkijPP2Z/o28Hpy6y8qxmUkkK4ByUXSc9Hgc`；若不一致，停止并调查。不要用一次 `ssh-keyscan` 的输出直接建立信任。脚本禁用密码交互、代理转发、隧道、跳板和主机密钥自动更新。

外部 JSON 配置字段如下；尖括号必须替换为本机绝对路径，**不要把替换后的文件放进仓库**：

```json
{
  "host": "8.148.245.224",
  "user": "daily-deploy",
  "port": 22,
  "identityFile": "<工作区外的加密私钥>",
  "knownHosts": "<工作区外的已核验主机公钥文件>",
  "runtimeNode": "<本机同版本Node可执行文件>",
  "baselineRecord": "<工作区外的基线记录文件>",
  "outputDir": "<工作区外的产物目录>",
  "recordsDir": "<工作区外的发布记录目录>"
}
```

### 服务器首次切换检查单（2026-09-23 已执行，部分人工验收待补）

这不是日常发布，需维护窗口和特权维护者操作。先保存当前配置、systemd/Nginx 文件及可读回验的受管一致快照。重新检查实际版本、锁、备份/保留 timer、盘空间、证书，并读清宝塔每日 11:26 的 cron 内容；未排除重复启停/备份任务前不切换。

1. 经审查的控制代码安装至 `/opt/daily-flow/control/ops`，root 持有。应用上传不能替换控制代码。不要从候选应用包安装高权限脚本。
2. 沿用 `/opt/daily-flow/managed-current`，**不要误用仍指向历史源码的 `/opt/daily-flow/current`**。复制并按现场核对 `ops/config.example.json`；移除 slots/activeSlot/upstreamFile，设置单实例 `unit`、4310 回环、实际库名和健康凭证文件。保留 `runtime.json` 对现有产物的正确绑定，`automationEnabled` 仍为 false。
3. 在维护态停止 blue/green，确认 MainPID 为 0、数据锁释放，禁用旧槽与旧自动 reconcile 启动入口。安装 `ops/systemd/daily-flow.service` 及原有 tmpfiles 锁规则；单实例 `Restart=no`，启动失败不得自动重跑迁移。**暂不 enable 应用自动开机启动**：重启服务器后先人工执行下述核对流程，不能让未完成操作的库被自动再次打开。
4. Nginx 仍代理到 4310，保留原 TLS 设置和 `/internal/` 拒绝规则。按 `ops/nginx/application.conf.example` 在 http 上下文定义 `daily_manual` JSON 日志格式，在此站点启用独立、无缓冲的 access_log；配置 `manualAccessLog` 指向该文件。字段仅 status/upstream/retryAfter，不记录业务正文、URL、令牌。`nginx -t` 通过后才 reload。
5. 保留 `daily-flow-backup.timer` 和 `daily-flow-retention.timer`，它们的 deploy.json 必须指向同一个单实例。每日七天、最近一次发布前及保护点仍受保留规则约束；不能为腾空间删除最后有效恢复点。
6. 部署账号只放公钥，保留 `ops/ssh-entry.sh` 对应 forced-command 和受限 sudo。禁止口令、PTY、转发、任意 shell；普通应用用户只能写数据和共享锁。安装/换钥需单独批准，不由日常发布升级权限。
7. 启动单实例，核对当前版本、真实数据深度健康、页面与公开链接、受管快照及 timer。新受控入口查询必须报告 `mode=single`。记录这次接管的维护耗时；失败保持维护、保留原数据与配置，不能临场盲目换回旧库。

首次接管前的只读预检逐项核对运行版本、服务、锁、备份、定时器、可用空间、Nginx、证书和环境变量。宝塔 11:26 的任务实际调用面板日志分析器，未发现日序服务、备份或代理控制命令。接管前建立并验证配套快照 `pre-cutover-1790150972597`，原配置、单元、Nginx 站点和控制代码保留在服务器 root 专用目录；安装经固定摘要核对的控制代码，切为单实例并启用站点专用 JSON 访问日志。`daily-flow-reconcile.service` 已禁用，单实例应用单元保持未 enable；每日备份与保留 timer 保持运行。受限入口独立返回 `mode=single`、原提交 `839c88a8f380c42f62c871df0bb95e92998f0e74`、非维护且未冻结。

随后用固定产物 `manual-a9084f06-c7bf-4709-8924-cb2eca6702de` 完成首发：实际提交与自报版本同为 `402863b909615ed0b3d74a44473dd40f11e581f3`，数据库 schema 为 9、完整性为 `ok`、附件可读，登录页与资产判据通过；发布前快照 ID 与发布 ID 相同。**首次发布**记录的维护时间为 **18,815 毫秒**，采样窗口 3 次请求、异常 5xx 为 0。首次接管工作单元总运行 14.866 秒，但没有单独记录接管的维护起止时间，不能把总运行时长当维护耗时。公网 `/health/ready` 和 `/login` 返回 200，`/internal/health` 返回 404；本机 Edge 无头浏览器打开登录页时页面有内容且无前端运行错误。维护者没有保存原公开分享链接，因此该项尚无法验收；不要为验收而在生产创建测试链接。

## 日常发布

在应用仓库运行，外部配置路径由维护者输入：

```sh
node scripts/manual-release.mjs --config <外部配置.json> --capture-baseline
npm run package:manual -- --config <外部配置.json>
npm run release:manual -- --config <外部配置.json> --package <打包输出的ID>
```

Windows PowerShell 使用 `npm.cmd` 调用 npm；本机 npm 12 的 `npm.ps1` 会把 `--config` 当作 npm 自身参数并报 `EUNKNOWNCONFIG`：

```powershell
$config = Join-Path $env:USERPROFILE 'daily-flow-private\manual-release.json'
node scripts/manual-release.mjs --config $config --capture-baseline
npm.cmd run package:manual -- --config $config
npm.cmd run release:manual -- --config $config --package '打包输出的ID'
```

首次或显式更新基线才执行第一行。它只调用 `manual-baseline`，以服务器受限 runtime 记录、当前目录和活跃服务的自报版本交叉核对后写入本机记录。日常先打包，再按打包输出的 ID 发布。打包命令刷新 `origin/main`、读取本机已捕获的基线，并在本机完成构建与临时数据库预检，**不连接生产服务器**；它在外部 `outputDir/<ID>/` 保存 `application.tar.gz`、`receipt.json`、`bundle.tar.gz`，在 `recordsDir/<ID>.json` 保存目标、提交和 SHA-256 摘要。发布命令先核验原包与记录，再查询实际生产基线；变化即拒绝上传，绝不重建此 ID。若需要一次命令完成构建与发布，仍可运行 `npm run release:manual -- --config <外部配置.json>`；Windows PowerShell 使用 `npm.cmd run release:manual -- --config $config`。

日常步骤：

1. 读取已捕获的基线，重新 fetch origin/main；拒绝脏工作树、未推送或与基线无祖先关系的提交。
2. 检查整个 baseline..HEAD 历史是否触及 `server/infrastructure/sqlite/`，包含删除、改名及改后撤回。命中时列出路径，并要求输入绑定两个完整提交的 `MIGRATE ... ...`；未确认或非交互终端即停止。无命中不询问。
3. 从固定提交导出临时源码，本机安装依赖并只执行 `npm run build`。不跑应用接口/页面回归，不跑旧迁移说明门禁。
4. 本机同版本 Node 在全新临时库中完成启动、版本、结构和完整性预检，退出并删除临时库；失败不连接服务器。运行依赖安装禁止安装脚本和 bin 链接，再核验归档安全。
5. 保存唯一发布 ID、原始 bundle 摘要和本机记录；发布时重新查询实际生产基线，变化即拒绝上传。通过 stdin 上传固定两个文件，不用 scp 或远程路径参数。
6. `manual-release` 把工作交给独立 systemd 单元，SSH 断开不杀服务器操作。服务器独占操作锁，预检产物，进入维护、停服、持有数据锁生成配套快照，然后换版、启动和验收。
7. 成功后取回服务器的脱敏记录。本机无法写记录不报成功。`recordsDir/ID.json` 的 `server` 部分是服务器返回的记录；其余是本机用于续看和验证的目标及包摘要。
8. 完成记录必须同时带回实际提交、快照标识、各项判据、维护开始与结束时间及实测维护耗时，任一缺失或不匹配都不算验收通过。维护耗时从进入维护态算到重新开放并确认登录页可访问；之后的公网就绪复核和日志读取仍须通过，但不计入对外不可用时长。只有全部吻合时，这条记录才改写基线文件，成为下一次发布的差异判定基准；用 `--resume` 重看一次更早的已完成发布不会把基线倒回去。

构建归档的 mtime、uid/gid、顺序和 manifest 的 `builtAt` 固定为源提交时间，便于用**相同提交、基线、Node/npm、依赖及构建平台**重建并比较摘要。真实执行时间记录在发布记录的 createdAt/finishedAt，不把 builtAt 当发布时刻。跨平台或不同工具版本不承诺字节完全一致；保留原始包始终是首选复现证据。

## 判据与结果

服务器检查进程 active、ready 自报提交、回环深度健康的预期 schema/integrity/附件可读、登录 HTML 及其 JS/CSS 资产可读，并扫描本次维护开始后此站点的 JSON access log。除明确维护响应（503、未到 upstream、Retry-After 60）外，任何新增 5xx 即失败；日志缺失、轮转或不可完整解析也失败。只覆盖记录中的采样时段，不代替持续监控。

**HTML/资产可读不是浏览器执行渲染证明，也不是业务写入验收。** 当前服务器不装浏览器；首次生产验收仍需维护者用浏览器检查页面和原公开链接。生产写入探针始终禁止。能通过这些检查的业务逻辑错误仍可能上线，这是 ADR 0006 的已知取舍。

维护预算目标为 180 秒，成功记录实际耗时。回滚/人工处置可能超过预算，不能为了满足时限在数据状态不明时开放流量。

开流量前预留 10 秒给代理登录探测；若开放后才确认维护实际超时，先完成公开就绪与访问日志判据。仅当这些判据通过时，记录失败和事故、冻结后续发布，但保持已恢复的服务可用，等待维护者核对并显式解除事故。其他开放后判据失败仍进入维护态。

| 结果                         | 站点与后续动作                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| completed                    | 新版已通过当前判据并对外开放；保留双端记录与原始包                                                                               |
| failed / baseline-restored   | 自动恢复发布前代码、数据、配置并复验，站点可用但本次发布仍失败；调查原因并显式解除冻结                                           |
| failed / manual-intervention | 恢复本身失败或阶段不明；保持维护、保留现场，不再次恢复覆盖                                                                       |
| failed / preserved-new-data  | 已可能开放流量，绝不自动恢复旧数据；保留当前数据，人工处理。仅“开放后确认预算超时且其他判据通过”保留服务可用；其他失败保持维护态 |
| unknown                      | 请求/进程状态无法确定，禁止重发或重建该 ID；由特权维护者核对                                                                     |

任何失败都保留原 ID 的结果；换一个 ID 也不能绕过事故冻结。禁止删锁、删 receipt 或改 phase 来“继续”。发布前快照新增唯一目录，不覆盖上一次材料；清理由既有保留链路执行，不额外询问人在不在，保护依靠首次失败即停止和保护点规则，而非覆盖唯一副本。

## 断线续看

```sh
node scripts/manual-release.mjs --config <外部配置.json> --resume <原ID>
```

先读取原记录和原 bundle，核验摘要，再查询状态。只续看已受理工作；failed/unknown 不重跑、不重新构建。不确定上传是否完成时只接续同一摘要，不产生新发布。观察最多四分钟，超时并不等于服务器失败，再次显式续看即可。换电脑需要原 ID 的记录、原包、经核验的主机公钥和已批准的密钥使用环境，不能凭记忆重建材料。

## 特权人工核对与解除冻结

以下在服务器可信管理会话中执行，不向部署账号放开任意恢复权限：

```sh
node /opt/daily-flow/control/ops/control.mjs --config /etc/daily-flow/deploy.json status --id <原ID>
systemctl status daily-flow-operation-<原ID>.service --no-pager
journalctl -u daily-flow-operation-<原ID>.service --no-pager
node /opt/daily-flow/control/ops/reconcile.mjs --config /etc/daily-flow/deploy.json
```

核对入口不打断活跃 worker。确认 worker 已死且尚未开放、恢复没有开始、存在验证过的发布前快照时，才允许一次配套恢复；回滚中断、记录损坏或可能开放一律保持维护。原数据在 `dataDir.before-restore-<恢复ID>` 中留存，不因重试删除。

恢复失败时先封存失败记录、快照及当前数据现场，确认库与代码实际状态，修复运行环境/当前代码；不得只换旧代码配新库。可能开放过后不承诺一键切回：若确需使用旧恢复点，必须先另行确认当前新增数据如何保留，这是新的人工恢复决策。

确认当前数据与代码已匹配后：

```sh
node /opt/daily-flow/control/ops/control.mjs --config /etc/daily-flow/deploy.json resolve-incident --id <新的处理ID> --incident <事故ID> --expected-commit <当前实际完整提交> --note '<原因与处理说明>'
```

此命令重新核对真实版本和数据健康，才解除维护/冻结；不恢复旧库，也不重新执行原发布。然后重新捕获基线，修正并推送候选提交，创建新的发布。服务器重启后也先核对而不是直接 start 应用，以免重新执行半完成迁移。

## 工具链验收与未完成交接

改动发布脚本、快照或保留代码后手动运行：

```sh
node --test scripts/release-guards.test.mjs scripts/manual-artifact.test.mjs scripts/manual-release.test.mjs
npm run typecheck
```

主机验收使用 `ops/testing/Dockerfile` 的独立 Linux systemd/Nginx/sshd 容器，运行 `ops/testing/*.test.mjs`；新文件由 `scripts/verify-host-control.mjs` 自动发现。使用配套 `/fixture-runtime`、`/fixture-artifact` 及含旧门禁 proof 的 `/candidate-artifact`，不能把缺少 plan/upgrade 的夹具失败冒充业务缺陷或全绿。不要在生产执行故障注入测试；不要并发堆积几十份未清理 fixture。

仍待核对：现有公开分享链接的浏览器访问（维护者没有保存可用链接）。首次切换时使用的 root 登录密码曾在对话中暴露，应另行更换；日常发布只使用已验证的受限密钥账号。同机快照不覆盖服务器或磁盘整体丢失；服务器不拉取浮动分支、不安装构建工具链。
