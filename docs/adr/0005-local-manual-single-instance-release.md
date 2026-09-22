# 撤回双槽单活发布，改为维护者本机发起的单实例手工发布

Status: accepted；取代 [ADR 0003](0003-single-active-deployment-slots.md) 的运行形态与发布触发方式，继承其流量开放边界
Date: 2026-09-21

2026-09-21 自动发布与小时巡检关停（`docs/cicd-production.md` 记录的原因仅为"改为手动推送合并"，无技术故障），随后确认生产发布改由维护者本机发起：本机 Windows 构建版本产物，经 SSH 交给服务器上的受控发布入口，由该入口在同一个停服窗口内取得一致快照、换版本并重启，接受不超过 3 分钟的维护窗口。生产回到单个 `daily-flow.service` 实例，不再使用 blue/green 两个版本槽位。

> 动机段落按 2026-09-21 盘问会话中用户的逐项选择归纳，用户未逐字确认，有出入以更正为准：单人维护希望发布这件事完整发生在自己键盘上、不挂在外部 CI 与自建状态机上；已验收的双槽与发布控制器带来的收益，抵不过它超出个人即时理解范围的心智与运维负担。

## Considered Options

- **保留控制器，只把触发端从 GitHub 换到本机**（调用既有受控 `release` 入口）。盘问中曾作为推荐项提出，被否决：要求继续维护双槽与 owner 守卫。
- **继续自动化，仅改为人工合并**（重新启用两条 workflow）。未选。
- **彻底手工**（本决定）。

## Consequences

- 双槽与 owner 守卫不再参与生产：`ops/systemd/daily-flow@.service`、`daily-flow-reconcile.service`、`ops/control.mjs` 的发布与切槽链路、`.github/workflows/` 两个作业全部保留在仓库但不再执行，也不删。
- **备份与保留链路仍是活代码**，不能随控制器一起废弃：每日自动备份继续用 `daily-flow-backup.timer` 的受管一致快照，`ops/dispatch.mjs`、`ops/snapshots.mjs`、`ops/retention.mjs` 都要留。代价是它的停服目标从活动槽改为单实例，需要相应修改。
- 失去"重载 Nginx 即回到旧版"的能力。回滚改为恢复本次发布前的一致快照，且必须同时恢复数据与配套旧代码——数据库迁移只有 additive、没有 down，只还原其中一半会造成代码与库结构错配。
- 恢复副本数量与寿命由受管保留策略决定（每日 7 天 + 最近一次发布前 + 保护点不因腾空间删除），不再遵循"每次发布覆盖上一份备份"。
- 服务器上不执行 `git clone` / `git pull`。`docs/deployment.md` 中"不要在正在运行的发布目录里直接 `git pull`"的约束**继续有效**，因为新流程上传的是构建产物而不是源码树。
- 继承 ADR 0003 的边界：自动回滚只覆盖"尚未重新开放流量"的失败；一旦可能接收过写入，保留现有数据、保持维护态并人工处理。自动回滚自身也失败时同样保持维护、保留现场、不循环重试。
- 单实例意味着发布窗口内网页与 MCP 同时不可用，且不再有"另一槽待预检"的能力；版本预检改在本机与服务器临时目录完成，见 [ADR 0006](0006-no-automated-gates-in-release-path.md)。

完整流程与逐项决策见工作区 `.scratch/daily-flow-manual-deploy/spec.md`。

## 2026-09-22 实施核对

上文"代价是它的停服目标从活动槽改为单实例，需要相应修改"经隔离环境实测**不需要改代码**：`ops/host.mjs` 的停服与启动本来就打 `config.unit` 这一个字段，槽位专属动作（owner 许可、`release.json` 取自哪个链接、代理 upstream）都在 `if (config.slots)` 之后，因此一份不含 `slots` 的配置就是单实例形态。真正缺的是两样，本次补上：单实例的应用单元此前只以正文形式躺在 `docs/deployment.md`，现在落成 `ops/systemd/daily-flow.service`；以及没有验收覆盖"无槽配置下每日备份、保留判定与配套恢复仍然成立"，现在由 `ops/testing/single-instance.test.mjs` 覆盖。附带确认：无槽配置下快照后写入的 `stateDir/runtime.json` 不含 `slot`，也不会生成 `owner.json`。
