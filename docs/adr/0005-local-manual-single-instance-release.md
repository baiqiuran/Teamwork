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

- 双槽与 owner 守卫不再参与生产：`ops/systemd/daily-flow@.service`、`daily-flow-reconcile.service`、`ops/control.mjs` 的发布与切槽链路、`.github/workflows/` 两个作业全部保留在仓库但不再执行，也不删。（这是 2026-09-21 的决定；workflow 的后续处置见文末。）
- **备份与保留链路仍是活代码**，不能随控制器一起废弃：每日自动备份继续用 `daily-flow-backup.timer` 的受管一致快照，`ops/dispatch.mjs`、`ops/snapshots.mjs`、`ops/retention.mjs` 都要留。代价是它的停服目标从活动槽改为单实例，需要相应修改。
- 失去"重载 Nginx 即回到旧版"的能力。回滚改为恢复本次发布前的一致快照，且必须同时恢复数据与配套旧代码——数据库迁移只有 additive、没有 down，只还原其中一半会造成代码与库结构错配。
- 恢复副本数量与寿命由受管保留策略决定（每日 7 天 + 最近一次发布前 + 保护点不因腾空间删除），不再遵循"每次发布覆盖上一份备份"。
- 服务器上不执行 `git clone` / `git pull`。`docs/deployment.md` 中"不要在正在运行的发布目录里直接 `git pull`"的约束**继续有效**，因为新流程上传的是构建产物而不是源码树。
- 继承 ADR 0003 的边界：自动回滚只覆盖"尚未重新开放流量"的失败；一旦可能接收过写入，保留现有数据、保持维护态并人工处理。自动回滚自身也失败时同样保持维护、保留现场、不循环重试。
- 单实例意味着发布窗口内网页与 MCP 同时不可用，且不再有"另一槽待预检"的能力；版本预检改在本机与服务器临时目录完成，见 [ADR 0006](0006-no-automated-gates-in-release-path.md)。

完整流程与逐项决策见工作区 `.scratch/daily-flow-manual-deploy/spec.md`。

## 2026-09-22 实施核对

上文"代价是它的停服目标从活动槽改为单实例，需要相应修改"经隔离环境实测**部分成立**：主路径不用改——`ops/host.mjs` 的停服与启动本来就只打 `config.unit` 一个字段，槽位专属动作（owner 许可、版本槽链接切换）都在 `if (config.slots)` 之后，所以一份不含 `slots` 的配置就是单实例形态，每日备份、保留判定与配套恢复在改造前已经可用（`backup.test.mjs` 用的基础夹具本来就没有槽位）。需要改的是**善后路径**，它们无条件解引用槽位，因而单实例下每次都会抛 `TypeError`：核对入口 `reconcile.mjs` 因此无法解除"上次操作被打断"的冻结（`control.mjs` 只接受经它处理），人工解除事故冻结的 `resolve-incident` 同样进不去。这两处已修，并由 `ops/testing/single-instance.test.mjs` 覆盖。

同次补上的还有两件：单实例的应用单元此前只以正文形式躺在 `docs/deployment.md` 且**不带数据锁**，现在落成 `ops/systemd/daily-flow.service` 并让该文档改为安装这个文件；`ops/config.example.json` 原先只描述双槽形态，现在描述当前生产形态（不含 `slots`/`activeSlot`/`upstreamFile`）。另外收紧 `snapshots.mjs` 写入 `runtime.json` 的条件为 `config.slots && config.activeSlot`，避免"删掉 slots 但留着 activeSlot"时记下一个并不存在的槽位。

## 2026-09-22 workflow 后续处置

上述“workflow 保留在仓库”的 2026-09-21 决定已被后续操作修改：`.github/workflows/{ci,deploy,inspection}.yml` 于 2026-09-22 从仓库删除，相关 GitHub Variable 和 Environment 也已清理；提交为 `4c50c48`。旧 `ops/` 与 `scripts/` 控制和测试代码仍保留，受管备份链路仍在使用。删除过程及恢复依据见 [CI/CD 接管历史](../cicd-production.md#2026-09-22-移除-workflow-定义与-github-侧配置)。

## 2026-09-23 维护预算越界时的处置细化

单实例发布在开流量前为 `/login` 探测预留时间。若开放后确认的实际维护时长仍超过 180 秒，且公开就绪与访问日志判据均已通过，则记录失败和事故、冻结后续发布，保留当前代码与数据及已开放的服务；再次关站无法消除已经发生的超时，只会延长不可用时间。这是对“开放后失败保持维护态”的一个窄例外，仅适用于单纯预算越界；其他开放后判据失败仍重新进入维护态并人工处理。维护者须核对现场并显式解除事故。
