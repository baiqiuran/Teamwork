# 日序：阿里云 ECS 公网 IP 部署手册

**2026-09-20 运维入口已切换：** 现有服务器由 blue/green 单活控制器接管，旧 `daily-flow.service` 已禁用。应用更新、备份、恢复和运行状态查询请使用 [CI/CD 生产接入与运维手册](cicd-production.md)；下文是首次建站记录，不能再直接用旧服务启动或恢复步骤操作已接管的生产环境。

本文记录 2026-09-18 在 Ubuntu 22.04 ECS 上完成并验收的部署，也可用于重建同类单机环境。当前入口为 <https://8.148.245.224/login>。`hrteamwork.com` **尚未切换到此服务器**；使用域名需要另行修改 DNS 并申请域名证书。

## 2026-09-18 首次部署清单

| 项目   | 当前值                                                                                       |
| ------ | -------------------------------------------------------------------------------------------- |
| 服务器 | `8.148.245.224`，Ubuntu 22.04，2 核 / 2 GB                                                   |
| 代码   | `https://github.com/baiqiuran/Teamwork.git`，提交 `8d08b2b959c7067e2125b7446681fb730a8c45a6` |
| 运行时 | Node.js `v24.15.0`、NestJS/React、SQLite                                                     |
| 应用   | systemd `daily-flow.service`；仅监听 `127.0.0.1:4310`                                        |
| 代理   | Nginx：80 端口跳转至 443，443 代理到应用                                                     |
| TLS    | Let's Encrypt 公网 IP 证书，Snap Certbot 自动续期                                            |
| 数据   | `/var/lib/daily-flow/daily-flow.sqlite` 与同级 `attachments/`                                |
| 备份   | `/var/backups/daily-flow/`；每日北京时间 04:00，保留超过 7 个完整日的备份会清理              |

服务器原有宝塔面板及 Nginx 默认站点未被替换。以下命令以具备 `sudo` 权限的 SSH 用户执行；如果使用 `root` 登录，可省略 `sudo`。**不要把登录密码、授权令牌或备份提交到 Git。**

## 1. 服务器与运行时

在阿里云安全组放行 TCP 22、80、443；应用端口 4310 只供服务器本机访问，不要加入公网安全组。若已有 Nginx 或其他网站，先运行 `sudo ss -ltnp` 查看端口和现有站点，再添加独立虚拟主机，不覆盖原配置。

安装 Git、Nginx、Snap 和 Node.js。当前部署使用官方 Node.js 发行包，并校验下载摘要：

```bash
sudo apt update
sudo apt install -y git curl xz-utils nginx snapd

cd /tmp
NODE_VERSION=v24.15.0
curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz"
curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
grep " node-$NODE_VERSION-linux-x64.tar.xz$" SHASUMS256.txt | sha256sum -c -
sudo install -d -m 755 /opt/node
sudo tar -xJf "node-$NODE_VERSION-linux-x64.tar.xz" -C /opt/node
sudo ln -sfn "/opt/node/node-$NODE_VERSION-linux-x64/bin/node" /usr/local/bin/node
sudo ln -sfn "/opt/node/node-$NODE_VERSION-linux-x64/bin/npm" /usr/local/bin/npm
node --version
npm --version
```

建立专用系统用户与目录：

```bash
sudo useradd --system --home /var/lib/daily-flow --shell /usr/sbin/nologin daily-flow
sudo install -d -o daily-flow -g daily-flow -m 750 /var/lib/daily-flow
sudo install -d -o root -g root -m 755 /opt/daily-flow/releases
sudo install -d -o root -g root -m 700 /etc/daily-flow
sudo install -d -o root -g root -m 700 /var/backups/daily-flow
```

若用户或目录已存在，跳过相应创建命令，不要重建现有数据目录。

## 2. 获取、构建和启动应用

先使用固定提交重现此次部署；后续升级时换成已审查的新提交。`npm run build` 包含架构与类型检查，`npm run test:api` 使用隔离数据库。本次在 ECS 上通过 41 项接口测试。

```bash
DEPLOY_SHA=8d08b2b959c7067e2125b7446681fb730a8c45a6
sudo git clone https://github.com/baiqiuran/Teamwork.git "/opt/daily-flow/releases/$DEPLOY_SHA"
sudo git -C "/opt/daily-flow/releases/$DEPLOY_SHA" checkout --detach "$DEPLOY_SHA"
cd "/opt/daily-flow/releases/$DEPLOY_SHA"
sudo npm ci
sudo npm run build
sudo npm run test:api
sudo npm prune --omit=dev
sudo ln -s "/opt/daily-flow/releases/$DEPLOY_SHA" /opt/daily-flow/current
```

应用的基础配置如下；公网访问还须完成第 4 节的 HTTPS 与 `DAILY_PUBLIC_URL` 配置，不需要先在本机创建团队。配置文件 `/etc/daily-flow/daily-flow.env` 的内容为：

```ini
NODE_ENV=production
PORT=4310
DAILY_DATABASE_PATH=/var/lib/daily-flow/daily-flow.sqlite
DAILY_CODEX_REDIRECT_URIS='["http://127.0.0.1/callback","http://127.0.0.1/callback/UmO3e8VUyNbu"]'
```

保存后执行 `sudo chmod 600 /etc/daily-flow/daily-flow.env`。`DAILY_CODEX_REDIRECT_URIS` 是 JSON 数组。当前公网 IP MCP 地址 `https://8.148.245.224/mcp` 对应的 Codex 回调路径为 `/callback/UmO3e8VUyNbu`；尾段由**服务 URL** 派生，并不是连接名 `daily_flow`。本次服务器上的固定提交需要如上手动登记；包含后续本地修复的版本会在配置 `DAILY_PUBLIC_URL` 时自动补登该精确路径，显式数组仍可用于其他客户端。切换域名或 MCP 地址后尾段会变化，须重新核对授权请求中的 `redirect_uri`。无端口登记允许该本机路径使用动态端口；仅有基础 `/callback` 不会授权带尾段的路径。不要把整条包含 `state` 或 PKCE 参数的授权 URL 写入配置。

建立 `/etc/systemd/system/daily-flow.service`：

```ini
[Unit]
Description=Daily Flow team workspace
After=network.target

[Service]
Type=simple
User=daily-flow
Group=daily-flow
WorkingDirectory=/opt/daily-flow/current
EnvironmentFile=/etc/daily-flow/daily-flow.env
ExecStart=/usr/local/bin/node /opt/daily-flow/current/build/server/main.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/daily-flow

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now daily-flow
sudo systemctl status daily-flow --no-pager
```

应用代码由 root 持有，`daily-flow` 用户只写数据目录。不要把数据库放在发布目录内；发布目录切换或删除时数据应保持不变。

## 3. 创建团队与登录

以下创建说明适用于持续开放创建的本地集成版本，不表示上文历史提交或现有生产已支持该行为，也不代表完整团队隔离已验收。`/setup` 在空站点、已有团队及重启后都保持开放，只填写团队名称、姓名、邮箱和密码；不需要引导密钥或 SSH 隧道。

每次启动都会打印 `日序已启动：<origin>` 和 `创建团队：<origin>/setup`。公网访问先完成第 4 节的 HTTPS、可信 `DAILY_PUBLIC_URL` 和同机代理配置，再从该可信地址打开 `/setup`。未配置公网地址时，应用仍只接受本机地址；这属于 Host/Origin 的站点安全边界，不是创建权限。密码规则与频率限制保持不变。

已有账号从 `/login` 使用原邮箱密码登录；创建新团队不能代替恢复原数据，加入已有团队仍须邀请，不能凭团队名称加入，也不能用已有账号邮箱另建或加入其他团队。可查看站点状态：

```bash
curl -fsS http://127.0.0.1:4310/api/setup/status
```

`needsSetup` 是布尔值：`true` 表示尚无团队，`false` 表示已有团队；它不是创建权限，两种状态下 `/setup` 都可创建新团队。

## 4. Nginx 与公网 IP 证书

先准备 ACME Webroot，并在 Nginx 中增加只处理该 IP 的 80 端口站点。签证前保持 80 端口可访问；此时还没有可用的 HTTPS 证书。

```bash
sudo install -d -m 755 /var/www/letsencrypt/.well-known/acme-challenge
```

将以下站点加入 `/etc/nginx/sites-available/daily-flow`，并链接到 `sites-enabled/`。如已有同名配置，先检查并保留其他站点：

```nginx
server {
    listen 80;
    server_name 8.148.245.224;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }
    location / { return 404; }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/daily-flow /etc/nginx/sites-enabled/daily-flow
sudo nginx -t
sudo systemctl reload nginx
```

从**另一台电脑**访问测试文件，确认公网 80 端口及 Nginx 都能提供挑战文件，随后删除测试文件：

```bash
echo ok | sudo tee /var/www/letsencrypt/.well-known/acme-challenge/daily-flow-check
# 在另一台电脑执行：curl -f http://8.148.245.224/.well-known/acme-challenge/daily-flow-check
sudo rm /var/www/letsencrypt/.well-known/acme-challenge/daily-flow-check
```

本次使用 Snap Certbot 5.8.0。发行版自带的旧 Certbot 1.21 不支持此次 IP 证书流程，因此命令明确调用 `/snap/bin/certbot`：

```bash
sudo snap install --classic certbot
/snap/bin/certbot --version
sudo /snap/bin/certbot certonly \
  --preferred-profile shortlived \
  --webroot --webroot-path /var/www/letsencrypt \
  --ip-address 8.148.245.224
```

按提示填写证书通知邮箱并接受条款。IP 证书需 Certbot 5.4 以上，证书有效期约 6 天，必须保持自动续期正常。可先按 [Let's Encrypt 的官方命令](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)使用 `--staging` 演练，正式签发时去掉它；**测试证书不受浏览器信任**。Certbot 只签发 IP 证书，不会自动修改 Nginx 的 TLS 配置。

签发成功后，将同一站点改成以下 80/443 配置，再测试并重载。服务器目前还另有一个 `hrteamwork.com` 的 80 端口站点返回 404；不要把该域名误认为已部署完成。

```nginx
server {
    listen 80;
    server_name 8.148.245.224;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }
    location / { return 308 https://8.148.245.224$request_uri; }
}

server {
    listen 443 ssl;
    server_name 8.148.245.224;
    ssl_certificate /etc/letsencrypt/live/8.148.245.224/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/8.148.245.224/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 28m;
    client_body_timeout 60s;

    location / {
        proxy_pass http://127.0.0.1:4310;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

```bash
sudo nginx -t
sudo systemctl reload nginx
```

在 `/etc/daily-flow/daily-flow.env` 最后增加：

```ini
DAILY_PUBLIC_URL=https://8.148.245.224
```

然后重启应用。`DAILY_PUBLIC_URL` 必须与浏览器访问地址完全一致，不带末尾斜线；HTTPS 代理必须覆盖 Host、`X-Forwarded-Proto` 和 `X-Forwarded-For`。网页写请求受同源校验，MCP 入口另用 Bearer 授权。

```bash
sudo systemctl restart daily-flow
sudo systemctl is-active daily-flow nginx
```

为续期后重新加载证书，建立可执行文件 `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh`：

```sh
#!/bin/sh
set -eu
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
```

```bash
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo systemctl enable --now snap.certbot.renew.timer
sudo /snap/bin/certbot renew --dry-run --cert-name 8.148.245.224
sudo systemctl list-timers --all | grep certbot
sudo /snap/bin/certbot certificates --cert-name 8.148.245.224
```

当前服务器的 Snap 续期定时器及上述 dry-run 均已通过。若机器上同时有旧版 apt Certbot 定时器，先确认它管理哪些证书；本次部署已停用旧定时器，仅由 Snap Certbot 续期该 IP 证书。

## 5. 备份与恢复

当前备份脚本位于 `/etc/daily-flow/backup.sh`。它使用 `flock` 防止重入，短暂停止应用，把 SQLite 数据库、可能存在的 WAL/SHM 和附件**同批**归档，然后重新启动应用、生成 SHA-256 校验文件。每日北京时间 04:00 运行；备份只在本机 `/var/backups/daily-flow/`，尚无异地副本。

```bash
sudo systemctl status daily-flow-backup.timer --no-pager
sudo systemctl start daily-flow-backup.service
sudo ls -lh /var/backups/daily-flow/
sudo systemctl is-active daily-flow
```

新服务器可安装以下备份脚本，再建立 timer。脚本文件权限设为 700，备份目录保持 root 专有：

```bash
#!/usr/bin/env bash
set -euo pipefail
umask 077
exec 9>/run/lock/daily-flow-backup.lock
flock -n 9 || exit 0
systemctl is-active --quiet daily-flow
backup=/var/backups/daily-flow/daily-flow-$(date +%Y%m%d-%H%M%S).tgz
partial="${backup}.partial"
systemctl stop daily-flow
trap 'systemctl start daily-flow; rm -f "$partial"' EXIT
tar -czf "$partial" -C /var/lib/daily-flow .
mv "$partial" "$backup"
sha256sum "$backup" > "${backup}.sha256"
find /var/backups/daily-flow -maxdepth 1 -type f -name 'daily-flow-*.tgz*' -mtime +7 -delete
```

`/etc/systemd/system/daily-flow-backup.service`：

```ini
[Unit]
Description=Back up Daily Flow data and attachments
After=daily-flow.service

[Service]
Type=oneshot
ExecStart=/etc/daily-flow/backup.sh
```

`/etc/systemd/system/daily-flow-backup.timer`：

```ini
[Unit]
Description=Daily Flow backup each night

[Timer]
OnCalendar=*-*-* 04:00:00
Persistent=true
Unit=daily-flow-backup.service

[Install]
WantedBy=timers.target
```

```bash
sudo chmod 700 /etc/daily-flow/backup.sh
sudo systemctl daemon-reload
sudo systemctl enable --now daily-flow-backup.timer
```

恢复前先检查备份完整性，并在临时目录试读 SQLite，避免直接覆盖在线数据：

```bash
BACKUP=/var/backups/daily-flow/daily-flow-YYYYMMDD-HHMMSS.tgz
cd /var/backups/daily-flow
sudo sha256sum -c "$BACKUP.sha256"
RESTORE_CHECK=$(mktemp -d /tmp/daily-flow-check.XXXXXX)
sudo tar -xzf "$BACKUP" -C "$RESTORE_CHECK"
sudo sqlite3 "$RESTORE_CHECK/daily-flow.sqlite" 'PRAGMA quick_check;'
sudo rm -rf -- "$RESTORE_CHECK"
```

`quick_check` 应输出 `ok`。本次部署的实际备份已通过该隔离检查，并确认包含团队与成员数据。确认要恢复的备份时间与当前代码版本匹配后，执行：

```bash
BACKUP=/var/backups/daily-flow/daily-flow-YYYYMMDD-HHMMSS.tgz
sudo sha256sum -c "$BACKUP.sha256"
STAMP=$(date +%Y%m%d-%H%M%S)
sudo systemctl stop daily-flow
sudo mv /var/lib/daily-flow "/var/lib/daily-flow.before-restore-$STAMP"
sudo install -d -o daily-flow -g daily-flow -m 750 /var/lib/daily-flow
sudo tar -xzf "$BACKUP" -C /var/lib/daily-flow
sudo chown -R daily-flow:daily-flow /var/lib/daily-flow
sudo systemctl start daily-flow
sudo systemctl is-active daily-flow
```

随后验收原账号登录、历史日报和附件下载，保留另存的旧数据直到验收完成。恢复会丢失备份时间之后的写入；若数据库经过新版本迁移，旧程序必须配套使用迁移前的旧备份，不能直接写新库。

## 6. 验收与日常维护

从外部电脑执行：

```bash
curl -I http://8.148.245.224/login
curl -I https://8.148.245.224/login
curl -fsS https://8.148.245.224/api/setup/status
curl -I https://8.148.245.224/mcp
```

预期 HTTP 跳转 HTTPS，登录页 200；已有团队时站点状态为 `{"needsSetup":false}`，这不是关闭创建入口的信号。匿名 `/mcp` 返回 401 表示鉴权边界生效；实际 Codex 连接仍需各成员单独授权。最后用已创建的账号在浏览器登录、进入工作空间。本次公网 HTTPS、登录、匿名鉴权、证书续期演练及备份试读均已验收。

常用维护命令：

```bash
sudo systemctl status daily-flow nginx --no-pager
sudo journalctl -u daily-flow -n 100 --no-pager
sudo nginx -t
sudo systemctl list-timers --all | grep -E 'certbot|daily-flow-backup'
sudo /snap/bin/certbot certificates --cert-name 8.148.245.224
```

更新版本时，先取得准备部署的完整 Git 提交 SHA，并确认升级说明及数据库迁移影响：

```bash
read -r -p '输入已审查的新版本完整提交 SHA: ' NEW_SHA
sudo git clone https://github.com/baiqiuran/Teamwork.git "/opt/daily-flow/releases/$NEW_SHA"
sudo git -C "/opt/daily-flow/releases/$NEW_SHA" checkout --detach "$NEW_SHA"
cd "/opt/daily-flow/releases/$NEW_SHA"
sudo npm ci
sudo npm run build
sudo npm run test:api
sudo npm prune --omit=dev

sudo systemctl start daily-flow-backup.service
sudo systemctl is-active daily-flow
OLD_RELEASE=$(readlink -f /opt/daily-flow/current)
sudo systemctl stop daily-flow
sudo ln -s "/opt/daily-flow/releases/$NEW_SHA" /opt/daily-flow/current.new
sudo mv -Tf /opt/daily-flow/current.new /opt/daily-flow/current
sudo systemctl start daily-flow
sudo systemctl is-active daily-flow
curl -fsS https://8.148.245.224/api/setup/status
```

最后用网页账号登录并检查关键页面。`OLD_RELEASE` 是切换前的代码位置，但旧代码不能保证兼容升级后的数据库；若新版本会迁移数据库，回退前必须评估是否需要恢复与旧代码匹配的备份。不要在正在运行的发布目录里直接 `git pull`，也不要让两个应用进程同时写同一个 SQLite 数据库。

目前公开地址仍是 IP。切换 `hrteamwork.com` 时，要先把其 A 记录指向本机公网 IP、以域名申请新的 TLS 证书、改 Nginx `server_name` 与证书路径、将 `DAILY_PUBLIC_URL` 改为 `https://hrteamwork.com`，然后重启应用并重新验收登录、公开链接及 Codex OAuth 地址。原 IP 公开链接和旧 OAuth 资源地址不会自动变成域名地址，切换前应规划迁移。

服务器曾在对话中使用明文 SSH 密码，交接后应更换该密码；现有宝塔面板端口 8888 的访问范围也应按实际管理需要限制。将 `/var/backups/daily-flow/` 另行复制到异地存储，才能在服务器整体故障时恢复数据。
