# 手工发布链路不设置自动测试与迁移说明门禁

Status: accepted；补充 [ADR 0005](0005-local-manual-single-instance-release.md)
Date: 2026-09-21

手工发布路径上自动执行的检查只有本机的 `npm run build`（其内部包含 `check:architecture` 与 `typecheck`）。原来在 CI 里跑的 41 项接口测试、10 项 Playwright 页面回归，以及 `scripts/verify-candidate.mjs` 的迁移说明门禁，都不再作为发布前置自动执行。这是用户在 2026-09-21 盘问会话中明知推荐项为"本机跑 `npm run test:ci` 全量 + 服务器侧预检"与"强制跑迁移门禁"之后所做的刻意选择，不是遗漏。

## 补偿措施

1. **可复现性**：构建前强制工作树干净、且 `HEAD` 已包含在 `origin/main` 中，否则拒绝构建。使发布记录里的提交号足以复现该次产物。
2. **产物可用性与版本一致**：上传前用**生产那一个 Node 二进制**配合全新临时数据库启动一次预检；开放流量前要求 `/health/ready` 自报的 `version` 与提交号一致。
3. **迁移不可逆点**：脚本自动判断本次待发布范围是否命中 `server/infrastructure/sqlite/`，命中则强制人工确认后才继续。这是 SQLite 迁移只有 additive、没有 `down` 的前提下，唯一挡住不可逆变更的闸。
4. **数据完整性**：开放流量前要求 `/internal/health` 返回的 `schema` 达到预期版本号且 `integrity` 通过；不过则触发自动回滚。

## Consequences

- 业务行为回归没有自动防线：一次能通过全部判据（进程 active、健康检查绿、只读页面可渲染）但业务逻辑已损坏的发布，会被记为成功。发现这类损坏只能依赖成员使用反馈。
- 判据不覆盖写入路径，因此明确不做生产写入探针——探针自检自删只能证明 INSERT/DELETE 未崩，会制造"已经验过"的错觉。
- 第 3 条依赖"本次发布范围"的正确计算。若跳过工作树干净校验（补偿 1），该判断也会失真。
- 迁移说明门禁的静态资产（`docs/migrations/automatic.json` 与 `scripts/verify-candidate.mjs`）保留在仓库且仍可手工调用；废弃的只是它作为自动闸的角色。
