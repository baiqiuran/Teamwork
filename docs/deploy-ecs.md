# 发布到 120.25.176.6

`deploy-ecs.bat` 按 SSH/SCP → 重启 systemd → 读取日志的方式发布本机 `app/` 当前内容，包含尚未提交的修改。默认目标为 `ecs-user@120.25.176.6:22`，独立使用 `/bim/new-chat`、`new-chat.service` 和回环端口 `4312`。

这是为新服务器提供的简化入口，与 ADR 0005/0006 中现有生产的受控入口、固定提交及基线检查流程不同；原服务器 `8.148.245.224` 继续使用 [手工发布流程](manual-release.md)。新入口不提供维护页、自动回滚或备份定期清理，不应当作原生产流程的替代品。

## 首次准备

本机需要 Node.js 24.15.0 或更新的 24.x、npm、Windows OpenSSH、tar。私钥放工作区外，默认 `%USERPROFILE%\.ssh\bim-test-2025-ecs-key.pem`，也可作为第一个参数传入。SSH 用户写作 `ecs-user@120.25.176.6`，`@` 前不用反斜杠。首次 SSH 连接时核对服务器主机指纹。

服务器需要 Bash、systemd、tar、curl、flock、runuser，以及 Node.js 24.15.0 或更新的 24.x（建议与本机完全一致）。脚本和 service 约定 Node/npm 位于 `/usr/local/bin/node` 与 `/usr/local/bin/npm`；若装在别处，同步修改两个文件。服务器需要能访问 npm registry；不会上传 Windows 的 `node_modules`。

用管理账号在服务器执行一次（账号已存在时跳过 `useradd`）：

```sh
sudo useradd --system --user-group --home-dir /bim/new-chat --shell /usr/sbin/nologin new-chat
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

## 每次发布

在 CMD 中执行：

```bat
cd /d C:\Users\NoOne\Documents\Codex\2026-09-16\new-chat\app
deploy-ecs.bat "E:\keys\bim-test-2025-ecs-key.pem"
```

PowerShell 中使用 `./deploy-ecs.bat 'E:\keys\bim-test-2025-ecs-key.pem'`。

脚本把构建所需源码复制到本机临时目录，安装依赖并构建，将 `build/`、`dist/`、包清单和锁文件打成压缩包，通过 SCP 上传，不改动开发目录的依赖和构建产物。服务器先在新版本目录安装 Linux 生产依赖，之后停服，在同一停服窗口复制数据库、WAL/SHM、附件和配置，记录旧版本路径，再切换链接并启动。旧版本目录完整保留；运行时只记录 Node 版本，并未复制运行时二进制。准备环境和排障时不要修改这些恢复材料。

失败返回非零退出码；若已进入停服阶段，会停止服务并写 `/bim/new-chat/NEEDS_ATTENTION`，后续发布拒绝继续。启动可能已迁移数据库，不能仅切回旧代码；先保留失败现场，再由管理员评估恢复同一副本的数据、附件、配置和旧版本。解除该标记前必须核对代码与数据已匹配。SSH 中断后也应先检查服务、标记和日志，不要直接重发。

成功条件是 service 活跃且 `/health/ready` 返回成功；这不代表浏览器和业务流程已经验收。发布后手动检查页面、登录和原公开链接。该简化脚本在启动后即可接收请求，不会自动还原旧数据库。

只构建打包、不连接服务器：

```bat
deploy-ecs.bat --package-only
```

本机包保留在输出的 `%TEMP%\new-chat-package-*` 路径；服务器上传包、`releases/` 和 `snapshots/` 均保留，按实际恢复需求人工管理磁盘空间。

持续查看日志：

```bat
ssh -i "%USERPROFILE%\.ssh\bim-test-2025-ecs-key.pem" ecs-user@120.25.176.6 "sudo journalctl -u new-chat.service -n 100 -f"
```

按 Ctrl+C 退出日志查看；不会停止服务。
