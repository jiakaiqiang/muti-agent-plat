# 版本化纠错与执行屏障开发记录

> 本文为接收/屏障里程碑的历史记录。后续新增的激活、过期结果接收和写回实现见 [纠错激活开发记录](correction-activation-report.md)；本文“尚未激活”的描述仅适用于本里程碑。

日期：2026-10-19。依据四件套 Spec、Plan、Task、Checklist，以及详细系统开发设计的版本、纠错事务和执行屏障章节。开发范围为 IR07、IR08.1/IR08.2、IR09.1 的基础切片；整个纠错闭环和阶段门尚未完成。

## 已实现行为

1. 区分 `routingRevision`（状态 CAS）、`intentRevision`（不可变语义计划版本）、`requirementRevision`（有效约束版本）、`executionEpoch`（执行屏障）。纠错接收只递增状态和屏障版本，不把尚未验证的新要求标成已生效。
2. 新增四类持久化实体和 PostgreSQL V23 additive schema：`intentRouteRevisionsBySession`、`intentResolutionReceiptsBySession`、`intentCorrectionsBySession`、`intentPlanStepsBySession`。已接入完整读取、增量写入、作用域验证、Session 删除、初始化清单和关系映射；V23 不修改历史迁移校验和。
3. File 在线事务和关系写入保护不可变 payload、复合唯一身份及 Session/路由/epoch 绑定。关系表使用所属 Session/路由的复合外键；版本/收据不允许普通在线 mutation 删除。File 的跨进程写入互斥没有因此获得保证。
4. 增加 `POST /sessions/:sessionId/message-routings/:routingId/corrections`，严格校验合同、版本、幂等键、请求正文和目标。客户端不能传入 `safeToApply`、模型决定或权限。202 返回纠错身份、待生效意图版本、路由版本、状态和受影响调用；同键同 payload 重放复用收据，同键不同 payload 返回 409。
5. 接收事务同时写入纠错、原输入事件、路由/受影响 WorkItem 的 hold 和 epoch、旧 queued step 失效、事件和 Outbox。已完成步骤保留。历史基线以 `authorizationState=unknown` 追加，只有真实存在的旧选择才转成澄清收据。
6. LogicalOperation begin/reserve 和 Runtime 异步准备完成后的启动边界读取持久化屏障；Git staging 准备后再检查。旧任务不能因恢复或重试绕过 hold。带新执行绑定的调用还必须匹配有效版本、需求版本、epoch、generation 和计划中的权限/决定摘要。
7. 纠错停止按受影响 invocation ID 发送，不改变整个 Session 的业务 admission，不取消另一个明确归属的 WorkItem。无法确定归属的旧业务调用采用保守阻断。旧分类回写与重新 claim 被拒绝。
8. `GET .../:routingId/corrections` 返回纠错和不可变版本历史。启动恢复会继续处理 accepted/waiting_for_stop；删除或 epoch 变化后的旧纠错工作不会重新创建数据或继续发停止请求。

## 当前状态机的开发边界

目前接通接收、停止请求、停止核对和保留屏障；未接通完整的新语义校验与计划激活。

- 无运行中受影响调用：进入 `validating`，记录 `CORRECTION_PLAN_VALIDATION_PENDING`，等待后续新计划校验实现。该状态不代表校验完成，也不是要求用户澄清。
- 有运行中调用：停止未确认或已确认但效果尚未核对，进入 `reconciliation_required`；停止完成不等于副作用已经撤销。
- 处理失败或重启不自动释放 hold。当前 API 没有“跳过校验恢复旧计划”的后门。
- 当前不会产生 `applied`，不能把本报告的 202 接收率称为纠错成功率。普通聊天纠正转同服务、Decision supersede 与新计划激活的原子提交、效果对账、全路径迟到结果/写回防护和双客户端纠错界面仍待实施。

## 验证范围

真实 localhost HTTP 使用隔离 File 数据和 mock 分类器，执行 VC01–VC08：严格输入、过期版本、重复并发、路由与任务同时冻结、幂等键冲突、旧卡失效、已接收与已生效区分、真实服务进程重启。原始结果见 [HTTP 结果](versioned-correction-http-results.json)，脚本为 `tests/evaluation/run-intent-versioned-correction-sdd.mjs`。

服务测试使用独立临时 File 数据，验证事务写入失败无部分提交、单一并发胜者、重启后持久化屏障、跨 Session/epoch 引用拒绝、不可变历史、queued step 失效但 completed 保留、删除后不复活。运行时测试检查实际 Adapter 调用次数和精确取消目标；没有调用真实 Codex/Claude 模型或认证其 OS sandbox。

PostgreSQL 独立连接集成测试已编写，覆盖并发、版本不可变、重新加载、派发屏障与删除。当前缺少 `RELATIONAL_TEST_DATABASE_URL`，该测试跳过，不能将关系 SQL 与单元测试视作真实 PostgreSQL 通过。

全仓首轮发现初始化清单未包含四类新记录，原失败保存在 `workspace-tests-versioned-correction.log`。已补齐初始化清单；`correction-seed-regression.log` 记录 24 通过、1 个 PostgreSQL 跳过。

最终检查的命令、退出码、计数和源码指纹另见本目录更新后的 README 与 `versioned-correction-manifest.json`。不同日志包含重复测试，不累加成独立意图题数。

## 后续实施

接通纠错语义校验和新版本激活事务，再将执行结果和写回纳入版本校验；并行功能意义上的依赖仍包括新合同主入口和实际效果授权。IR07–IR09 保持部分实现，IR11 ordered_plan 保持关闭。独立人工标注、真实数据库/CLI/双客户端验收、迁移演练和发布门继续保留，未执行生产变更。
