# CI/CD 实施与验证

已提供固定提交构建入口（任务 01）和指定源版本的升级验证入口（任务 02）。生产自动发布尚未启用；双槽切换、备份和恢复等后续任务通过后才能上线。

## 固定提交产物

在 Node 24.15.0、Git、tar、已安装 Playwright Chromium 的 Linux 环境运行：

```sh
npm ci
npx playwright install --with-deps chromium
node scripts/release-artifact.mjs build --commit "$(git rev-parse HEAD)" --output /tmp/daily-release-unique
```

输出目录必须不存在。构建从指定完整 SHA 的 Git 归档读取源码，不读取工作区修改或未跟踪文件。在独立临时目录执行锁定安装、架构和类型检查、前后端构建、业务接口与页面测试；完整套件只运行一次。随后在另一目录只安装生产依赖，启动编译后的服务，验证登录、日报提交、公开读取、OAuth 与 MCP 实际写入。所有业务数据均为临时合成数据，校验完成即删除。

成功输出 `application.tar.gz` 和 `receipt.json`。包内有生产依赖、前后端和 `release.json`；凭据记录完整提交、包 SHA-256、Node/操作系统/CPU 架构、应用版本及检查列表。工作区数据、开发依赖和验证产生的数据不会打入运行包。任一检查失败不会产生新的成功凭据；已存在的输出目录不能被覆盖。

当前凭据明确标记 `deployable: false` 和 `migrationVerified: false`，不能跳过实际线上版本到候选版本的升级验收而直接部署。Windows 可用于本地回归，但其包不能当作 Linux 运行产物。

## CI

`.github/workflows/ci.yml` 在 PR、main 推送和手动触发时运行 `Verified Linux artifact`。使用 Ubuntu 22.04、固定 Node 24.15.0 和锁定版本的 Chromium；检查完成后才上传产物。仅授予 `contents: read`，不引用生产 SSH、真实成员或 OSS 凭证，不使用 `pull_request_target`。

历史兼容验证、生产基线证明、main 保护与部署作业会随对应任务接入，当前构建检查不代表全部发布门槛已满足。

## 复用验证

`npm run test:production` 保留本地开发验证入口：复制开发工作区到临时目录并运行完整套件，再调用与 CI 相同的纯生产依赖验证。它用于检查尚未提交的开发改动，不能替代固定 SHA 发布入口。

```sh
node scripts/verify-runtime.mjs /absolute/path/to/extracted/runtime
node --test scripts/release-artifact.test.mjs
```

运行包验证始终创建自己的临时数据库，并清除调用者的日序运行配置。不要把生产环境凭证注入测试作业。

## 任务 01 验证记录（2026-09-20）

- 受检提交：`42d0bea18c6e929bc98c72bf1e3f5e004724974b`。
- 本机 Windows 与隔离 Linux 均通过架构/类型/构建、42 项 API、10 项 Chromium 页面和 3 项产物入口回归。
- Linux：官方 `node:24.15.0-bookworm` 镜像，摘要 `sha256:f22d6a1f082c02f292e86929b5b0442ac2e5eaf438a5dea9b1566601c3e05940`。失败检查和不合法提交身份均被拒绝；压缩包独立解压后再次通过生产依赖 HTTP/OAuth/MCP 验证。
- Linux 包 SHA-256：`5f95947bf54667636813590579718c8025550f606ba595b8740b11a6f55ccd3f`。
- Standards 审查与 Spec 审查的问题已修复：校验脚本使用归档版本、拒绝 tree/tag 对象冒充提交；Linux npm 路径经实跑修正。
- 这是本地隔离 Linux 验收，GitHub 托管作业尚未实际执行，生产部署未启用。

## 候选升级门槛

在具备完整 Git 历史、当前开发依赖和目标运行平台的隔离环境运行：

```sh
node scripts/verify-candidate.mjs --from OLD_FULL_SHA --current ACTUAL_FULL_SHA --artifact /path/to/verified-artifact --plan /path/to/migration-plan.json --output /path/to/new-upgrade-evidence.json
```

`--current` 是调用方刚读取的实际线上版本，必须与 `--from` 相同；排队期间版本改变后必须重新验证。服务器端再次读取实际版本属于发布控制步骤，不能仅信任调用者保存的旧值。目标取自产物凭据，并验证摘要、平台、Node 版本、清单与祖先关系；缺失历史直接失败。

迁移说明示例（没有持久化代码变更时 `changes` 为空，但仍需说明）：

```json
{
  "from": "完整旧提交 SHA",
  "to": "完整候选提交 SHA",
  "automatic": true,
  "description": "本次版本及迁移范围说明",
  "changes": [
    {
      "commit": "范围内修改持久化代码的完整提交 SHA",
      "path": "server/infrastructure/sqlite/ai-migrations.ts",
      "kind": "additive",
      "description": "新增字段及其默认值、兼容性依据"
    }
  ]
}
```

检查整个提交跨度中的持久化适配与初始化变更，说明必须逐提交、逐文件对应。`server/infrastructure/sqlite/` 与组合根的初始化变更使用 `kind: "additive"`；普通适配器业务改动使用 `kind: "runtime"`，正常业务 UPDATE/DELETE 不被误判为迁移。结构变更必须放在集中迁移目录。迁移代码中的改写既有数据、删表/删列/重命名保守地转人工维护；跨行、带引号也不会放行，仅标注“additive”不能绕过检查。允许范围内仍要实际启动旧版本建立合成团队数据，运行候选迁移，比较原表、字段与既有行，并经业务接口验证会话、成员授权、日报、任务、公开链接和附件，再恢复匹配的旧代码及备份。原始 pre-MCP 历史基线的升级与恢复也继续执行。

源版本应是已有 `build:server` 的编译版部署；更早的历史版本由保留的专用历史基线验证覆盖。生成的独立证据绑定源/目标 SHA、原产物摘要、迁移说明、验证脚本摘要和完整范围差异摘要；不改写原始产物凭据，也不把升级通过等同于所有上线条件通过。

## 任务 02 验证记录（2026-09-20）

隔离 Linux 中，`73ab191fc515d900e48b96802edfa67cb8234708` 到 `4fddcd678f801a5e0f8fc7dd1bd0f9944954f55f` 的升级及匹配恢复通过，同时通过原始 `4414749` 历史基线。候选包摘要为 `45eeb3ef8b7451c57ade5b828258fd2dfc8d274ddada76bd901dbcde1095db20`，完整构建含 42 API/10 页面测试通过。Windows/Linux 的 3 项候选入口回归覆盖基线变化、说明缺失、破坏性 SQL 与业务 CRUD 区分。实际给编译候选注入删除日报行为时，验证因 `DESTRUCTIVE_MIGRATION` 失败，未把文字说明当作兼容证据。静态检查按审查补齐跨行、引号及 REPLACE 场景。这些是显式源版本的隔离验证，不是实时线上发布证明。
