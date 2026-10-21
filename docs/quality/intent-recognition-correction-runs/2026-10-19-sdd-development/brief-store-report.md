# Brief 草稿事务与版本守卫开发记录

Run ID：`SDD-2026-10-20-brief-store`。这是 IR06/IR09 的执行前置基础，完整专项及首轮 Brief 链路仍未完成。

## 改动

新增 `IntentBriefStoreService` 和服务端派生步骤 helper。prepare_brief 只存在于已校验服务端计划，不进入 intent_understanding 的模型动作枚举。创建 WorkItem 的父步骤绑定目标后，才能派生独立步骤；保留原文证据、上下文策略、效果 hash 与版本 binding。当前不注册自动派发：测试夹具在真实 PlanCommit 事务内补入派生步骤，模拟未来执行器的 running 租约。

保存候选与发布分开。候选必须符合 task_brief 1.0，限制 100000 UTF-8 字节及 50 条建议任务，同一物理调用不能覆盖为不同结果。发布时核对 session/epoch/active WorkItem、不可变计划的父/子步骤、父步骤完成、租约与截止时间、实际 invocation、Decision hash、纠错 hold、暂停和停止状态。旧处理不能发布新草稿。

Brief、建议任务、当前 Brief 状态、brief_created、确认卡和两条 Outbox 在一个事务内保存；写入失败不留下半张卡或半个 Brief。结果已保存时可从 File 重载补发，完整发布重放仅返回历史结果，不增加事件。Brief.intentBinding 保留路由/意图版本/步骤/调用来源。

confirmed Decision 中的约束为草稿已确认约束来源；模型生成而账本没有确认的约束只进入 openQuestions。所有建议任务强制保持 requiresUserConfirmation，不创建 AgentTask，不授权业务执行，也不写 workspace 文件或 Artifact。确认卡是后续确认流程的待接入合同，当前生产入口不会生成它。

Runtime 边界对有 executionBinding 的 brief_generation 限定 business 准入、具体 step/workItem、task_brief 1.0、空效果/grant/工具/工作区能力、无 CLI resume，仅 Generic LLM/mock。持久化守卫拒绝借父创建步骤、其他 phase 或旧 invocation 执行；没有新增 CLI 权限。

## 验证

| 检查 | 结果 |
| --- | --- |
| Brief/提交/回答/Runtime 策略相关回归 | 58 通过，0 失败 |
| Server 全量 | 2174 + 7 通过，0 失败，41 条件跳过 |
| Shared 全量 | 285 通过，0 失败 |
| PostgreSQL 独立运行 | 36 通过，0 失败，0 跳过；临时容器已清理 |
| 全仓类型检查 | 通过 |
| Shared 与 Server 构建 | 通过 |

12 个 Brief 服务测试覆盖发布去重、File 写盘失败/重载、约束来源、hold/generation/pause/epoch/lease/Decision/父步骤变化、候选不覆盖、Schema 与大小限制、服务端动作不能由模型提交，以及 Runtime phase/物理调用和父步骤借权拒绝。Shared 新增受限 Brief Runtime 正负用例。

PostgreSQL 使用真实独立连接，验证同一候选并发发布只产生一个 Brief、一组建议任务、一张确认卡与唯一 Outbox；SQL trigger 注入 Brief 插入失败时全部投影回滚，已保存候选保留。最后一次数据库运行额外将建议任务夹具改为非空，验证实际 relational 建议任务记录及 requiresUserConfirmation，不仅检查空集合。此最后增量只修改测试夹具，由 `brief-store-postgres-complete.log` 覆盖；前面的 Server 全量和构建覆盖全部生产代码。

Server 中 41 条件跳过为 36 PostgreSQL 与 5 可选 Docker 执行器测试；36 项由独立 PostgreSQL 运行通过，5 项可选 Docker 本轮未重跑。计数重叠，不合计为独立场景总数。本轮未跑整个工作区的所有测试或完整 Web/Desktop 构建；没有 UI 行为改动，全仓类型检查覆盖共享合同消费。

## 失败记录

初始类型检查发现停止状态使用了不存在的 none，改为真实生命周期 idle/confirmed。首批 11 个服务测试通过，补上 Runtime 入口后最终为 12 个，相关集为 58 个。

首次 PostgreSQL 启动探针误认镜像初始化时的临时 Unix socket 服务就绪，随后查询版本遇到 “database system is shutting down”；测试还没有开始。初次 JSON 保留 exitCode=null、cleanupConfirmed=true。探针改为等待 127.0.0.1 的正式 TCP 服务后运行通过，未以延时盲重试业务事务。初始/最终证据文件分开保存。

## 下一依赖与未验收项

- 尚未将派生 helper 接入生产 PlanCommit，也未注册自动 Brief 执行器；不存在真实模型生成或 Sessions HTTP Brief 端到端证据。
- 后续需实现持久化领取/有限预算/单层修复/取消恢复，生成时重建当前有效上下文；接通实际 Runtime 后再启用派生步骤调度。
- 还需迁移 Orchestrator 的旧 Brief/建议任务 Map 读取及写入，防止新事务被旧缓存覆盖；新确认流程不能沿用会直接启动旧无绑定业务的路径。
- 通用 Brief 修订、确认后专业任务、源码/外部效果、完整双端/CLI/SSE/崩溃矩阵、独立模型评测和发布门仍未完成。

不把以上存储夹具当作真实入口或模型准确率证据；Spec 范围不缩减，IR06/IRC-AC01/10/13 与整体阶段门保持未勾选。没有提交、发布、生产数据库或个人模型配置变更。代码/文档/日志指纹见 `brief-store-manifest.json`。
