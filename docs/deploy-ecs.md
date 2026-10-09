# 发布到 120.25.176.6

`deploy-ecs.bat` 按 SSH/SCP → 重启 systemd → 读取日志的方式发布本机 `app/` 当前内容，包含尚未提交的修改。默认目标为 `ecs-user@120.25.176.6:22`，独立使用 `/bim/new-chat`、`new-chat.service` 和回环端口 `4312`。

这是为新服务器提供的简化入口，与 ADR 0005/0006 中现有生产的受控入口、固定提交及基线检查流程不同；原服务器 `8.148.245.224` 继续使用 [手工发布流程](manual-release.md)。新入口不提供维护页、自动回滚或备份定期清理，不应当作原生产流程的替代品。

## 2026-09-29 首次安装记录

- 已安装 Node.js v24.15.0（官方归档 SHA-256 核验通过）、账号和 systemd 单元；`new-chat.service` 正在监听 `127.0.0.1:4312`，保持未启用开机自启。
- 发布目录为 `/bim/new-chat/releases/20260929T065114Z-3903815`，首次空数据副本位于同 ID 的 `snapshots/`。应用构建自提交 `53dda7f`；简化包未包含 `release.json`，健康接口的版本字段为 `development`，不能据此判断 Git 提交。
- 健康接口、登录 HTML、JS/CSS 资源均通过检查；原 `Rid-Rs.service` 仍为 active，原 HTTPS 入口发布前后均返回 401。未创建业务测试数据。
- 用户指定公网地址 `https://daily.hbads.cn`，并决定稍后再添加 DNS 解析。当前未签发该域名证书、未配置 `DAILY_PUBLIC_URL`，使用下文 SSH 隧道访问。
- `/etc/nginx/conf.d/new-chat.conf` 仅开放证书验证路径，其他 HTTP 请求返回 503；HTTPS 草案保存在 `/etc/nginx/new-chat-https.conf.pending`，尚未启用。后续添加 A 记录指向此服务器后，再签发独立证书并启用 HTTPS 配置。
- 为适配此服务器，脚本 PATH 补充 `/usr/sbin` 和 `/sbin`；通过 ACL 仅给 new-chat 账号增加 `/bim` 的穿越权限，未修改原项目目录权限。

## 首次准备

本机需要 Node.js 24.15.0 或更新的 24.x、npm、Git、Windows OpenSSH、tar。私钥放工作区外，默认 `%USERPROFILE%\.ssh\bim-test-2025-ecs-key.pem`，也可作为第一个参数传入。SSH 用户写作 `ecs-user@120.25.176.6`，`@` 前不用反斜杠。首次 SSH 连接时核对服务器主机指纹。

服务器需要 Bash、systemd、tar、curl、flock、runuser，以及 Node.js 24.15.0 或更新的 24.x（建议与本机完全一致）。脚本和 service 约定 Node/npm 位于 `/usr/local/bin/node` 与 `/usr/local/bin/npm`；若装在别处，同步修改两个文件。服务器需要能访问 npm registry；不会上传 Windows 的 `node_modules`。

用管理账号在服务器执行一次（账号已存在时跳过 `useradd`）：

```sh
sudo useradd --system --user-group --home-dir /bim/new-chat --shell /usr/sbin/nologin new-chat
sudo setfacl -m u:new-chat:--x /bim
sudo install -d -m 755 /bim/new-chat /bim/new-chat/releases
sudo install -d -o new-chat -g new-chat -m 750 /bim/new-chat/data
sudo install -d -m 700 /etc/new-chat /bim/new-chat/snapshots
sudo touch /etc/new-chat/new-chat.env
sudo chmod 600 /etc/new-chat/new-chat.env
```

从本机 `app/` 上传并安装 service（私钥路径按本机填写）：

```bat
scp -i "%USERPROFILE%\.ssh\bim-test-2025-ecs-key.pem" scripts/new-chat.service ecs-user@120.25.176.6:/tmp/new-chat.service
ssh -i "%USERPROFILE%\.ssh\bim-test-2025-ecs-key.pem" ecs-user@120.25.176.6 "sudo install -m 644 /tmp/new-chat.service /etc/systemd/system/new-chat.service && sudo systemctl daemon-reload"
```

发布命令使用 `sudo -n`，要求该管理账号已有相应免密 sudo 权限。若现有账号不具备权限，须由服务器管理员安排；脚本不修改 sudoers。先不要启动 service，首次发布将创建 `current` 链接再启动。默认不启用开机自启；重启后先检查 `NEEDS_ATTENTION` 和日志，确认数据状态再手动启动。

`new-chat.env` 可以暂时为空，应用仅供 SSH 隧道访问。不要在此覆盖 `PORT` 或 `DAILY_DATABASE_PATH`，脚本的健康检查和数据副本依赖上述固定值。试用方式：

```bat
ssh -i "%USERPROFILE%\.ssh\bim-test-2025-ecs-key.pem" -L 4312:127.0.0.1:4312 ecs-user@120.25.176.6
```

保持连接，浏览器访问 `http://127.0.0.1:4312`。

公网访问需先为实际域名或 IP 配置可信 HTTPS 证书和同机 Nginx 代理，再在 `/etc/new-chat/new-chat.env` 写 `DAILY_PUBLIC_URL=https://实际站点地址`，重启 service。不能填写公网 HTTP 地址。代理到 `http://127.0.0.1:4312`，覆盖 `Host $http_host`、`X-Forwarded-Proto $scheme`、`X-Forwarded-For $remote_addr`，并用 `location ^~ /internal/ { return 404; }` 禁止外部访问内部接口。证书和 Nginx 不由本脚本安装。

### 启用 daily.hbads.cn 的 HTTPS

首次安装已在服务器保存 HTTP 证书验证入口和 HTTPS 草案。域名解析就绪后，在本机 `app/` 中执行以下命令，使用工作区外的实际私钥路径替换占位符：

```bat
scp -i "<私钥绝对路径>" scripts/configure-ecs-https.sh ecs-user@120.25.176.6:/tmp/new-chat-configure-https.sh
ssh -i "<私钥绝对路径>" ecs-user@120.25.176.6 "sudo -n bash /tmp/new-chat-configure-https.sh"
```

脚本使用既有 Certbot 账号签发独立证书，保存原配置，设置公网地址，启用 HTTPS 代理并重启应用；失败会恢复原应用与代理配置。证书签发仍需真实通过域名验证，不能以“假定已解析”替代。签发前不会修改应用地址。成功后还须从本机检查公网 HTTPS 访问和证书续期。

2026-09-30 此脚本已在本机准备并通过 Bash 语法检查；SSH 连接超时，尚未上传执行，不能视为 HTTPS 已启用。

2026-10-08 确认 `daily.hbads.cn` 的 A 记录已指向 `120.25.176.6`，公网 HTTP 证书验证路径返回 200；HTTPS 仍出现域名与证书不匹配。两次 SSH 连接（含显式 IPv4）均在 22 端口超时，本次未上传或执行 HTTPS 配置，服务器配置未变更。继续前需恢复当前网络到服务器 SSH 端口的访问，或提供已更改的 SSH 端口。

### 2026-10-08 HTTPS 启用记录

随后重试 22 端口成功，已上传并执行 `configure-ecs-https.sh`。独立证书包含 `daily.hbads.cn`，有效期至 2027-01-06；已启用服务器保存的 HTTPS 草案，并设置 `DAILY_PUBLIC_URL=https://daily.hbads.cn`。HTTP 请求以 308 跳转 HTTPS，Nginx 转发到 `127.0.0.1:4312`。原配置保存在 `/etc/new-chat/https-before.8Ihpr8Uh`。

公网验证：登录页面、JS/CSS 和 `/health/ready` 返回 200，`/internal/health` 返回 404；健康接口仍报告 `development`，此次仅修改证书和配置，未发布新应用版本。`new-chat.service`、`Rid-Rs.service` 和 Nginx 均为 active；原 `rid-rs.hbads.cn` 在操作前后均返回 401。证书续期 timer 为 active；应用保持未启用开机自启，服务器重启后仍需按首次准备说明检查并启动。

Certbot 已保存续期后检查并重载 Nginx 的 hook。首次续期演练在 CA 二次验证中遇到 DNS `SERVFAIL`，重新执行 `certbot renew --cert-name new-chat --dry-run --non-interactive --no-random-sleep-on-renew` 后成功；现有正式证书未被演练替换，公网登录页面复查为 200。

## 每次发布

首次安装和 HTTPS 已完成后，双击仓库根目录的 `deploy.bat` 即可再次发布。它使用 `E:\ridkey\bim-test-2025-ecs-key.pem`，调用现有发布脚本完成临时目录构建、上传、停服复制数据、切换版本、重启与健康检查，结束后保留窗口显示结果。不会重新安装 Node、签发证书或修改 Nginx；数据继续保存在 `/bim/new-chat/data`。这是快捷入口，须与 `deploy-ecs.bat` 和 `scripts/deploy-ecs.sh` 一起保留。

在 CMD 中执行：

```bat
cd /d C:\Users\NoOne\Documents\Codex\2026-09-16\new-chat\app
deploy.bat
```

PowerShell 中使用 `./deploy.bat`。需要换私钥时，使用 `./deploy-ecs.bat '<私钥绝对路径>'`。

脚本在临时目录固定构建来源：相关源码干净时从 Git 提交导出；存在本地修改时复制当前源码并记录内容摘要。不会要求工作区干净或提交已推送。安装依赖并构建后，将 `build/`、`dist/`、包清单、锁文件和 `release.json` 打包；归档外的 `receipt.json` 保存归档 SHA-256。SCP 同时上传归档、摘要和固定来源中的安装脚本，不改动开发目录的依赖和构建产物。

服务器核对接收归档的摘要和包内来源，先在新版本目录安装 Linux 生产依赖，之后停服，在同一停服窗口复制数据库、WAL/SHM、附件和配置，记录旧版本路径，再切换链接并启动。旧版本目录完整保留；运行时只记录 Node 版本，并未复制运行时二进制。准备环境和排障时不要修改这些恢复材料。

失败返回非零退出码；若已进入停服阶段，会停止服务并写 `/bim/new-chat/NEEDS_ATTENTION`，后续发布拒绝继续。启动可能已迁移数据库，不能仅切回旧代码；先保留失败现场，再由管理员评估恢复同一副本的数据、附件、配置和旧版本。解除该标记前必须核对代码与数据已匹配。SSH 中断后也应先检查服务、标记和日志，不要直接重发。

成功条件是 service 活跃、`/health/ready` 返回 `ready: true`，且版本与归档来源相符。纯提交的版本是完整提交号；含修改的版本为 `<提交号>-dirty.<源码摘要前12位>`，不能当作纯提交发布。无元数据的旧包仍报告 `development`，不补造历史版本。

每次安装保存 `release-record.json`，包含来源、归档实际和预期摘要、时间、发布目录、完整发布前快照、健康版本和结果；本机下载到打包目录。失败保留 `failed` 记录；连接中断且未取到服务器记录时，本机记为 `unconfirmed`，需核对现场，不能据此判断成功或失败。记录不包含配置、凭证或业务内容。健康通过不代表浏览器和业务流程已经验收，仍须手动检查页面、登录和原公开链接。该简化脚本在启动后即可接收请求，不会自动还原旧数据库。

只构建打包、不连接服务器：

```bat
deploy-ecs.bat --package-only
```

本机包保留在输出的 `%TEMP%\new-chat-package-*` 路径；服务器上传包、`releases/` 和 `snapshots/` 均保留，按实际恢复需求人工管理磁盘空间。

## 开发验证入口

在 Windows 的 `app/` 执行 `npm run test:ecs`，使用临时 Git 仓库验证干净和含修改的包；不连接 SSH。`scripts/ecs-install.test.mjs` 用真实 systemd 和应用健康接口验证安装、损坏归档、来源不符和健康版本不符。它仅供专用一次性 Linux 容器使用：只读挂载 `scripts/` 到 `/repository/scripts`、仅打包的输出目录到 `/fixture-package`，创建 `/fixture-ecs-only` 标记，再显式设置 `DAILY_ECS_FIXTURE=1` 运行 `node --test --test-concurrency=1 /repository/scripts/ecs-install.test.mjs`。容器需要 Node 24.15+、npm、systemd、tar、curl、flock、runuser；不得挂载服务器数据或在实际服务器运行。测试创建自己的账号、服务和 `/bim/new-chat`，完成后关闭并删除专用容器。这些验证由开发者手动执行，不是发布时的自动门禁。

持续查看日志：

```bat
ssh -i "%USERPROFILE%\.ssh\bim-test-2025-ecs-key.pem" ecs-user@120.25.176.6 "sudo journalctl -u new-chat.service -n 100 -f"
```

按 Ctrl+C 退出日志查看；不会停止服务。
