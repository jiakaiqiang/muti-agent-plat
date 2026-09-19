# 阶段 4：主 Agent 文档、精确确认与所选工作流交接 — Plan v1

> 日期：2026-09-16
> 状态：已实现并于 2026-09-19 通过用户验收；顺延缺口见阶段 5 Tasks 承接说明。
> 依赖：阶段 3 通过，复用 1 与 2A～2C 的隔离、预算、记忆和缓存。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-4-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-4-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-4-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-4-checklist-v1.md)

## 1. 目标、依据与决策

主 Agent 将讨论收敛为可查看、可比较、可确认的版本化方案；用户确认后选择系统发布的工作流，经过兼容性校验后只启动一次。

当前依据见同阶段 Spec 第 3 节。已沟通决定统一见总计划，本文将其映射为实现边界。

方案选择：沿用现有领域模块与共享合同，增量补强；不新增平行编排/上下文系统。收益是保持现有 Runtime、流程图、双端状态和数据可追溯性；代价是必须覆盖旧入口并完成版本兼容验证。

## 2. 可执行设计

### 2.1

优先扩展 TaskBrief/Artifact/DecisionRecord 的版本关系；若增加 RequirementDocument 聚合，必须引用现有 artifact 正文与 brief，不建立两套可独立修改的权威文本。主 Agent 可在受控 artifact 通道保存文档，讨论阶段不得以发布文档为由修改项目源文件。

### 2.2

文档模型拟含 workItemRevision、documentRevision、contentHash、sourceDecisionIds、sourceDelegationIds、status。确认事务先校验文档 hash 与需求快照，再写 confirmation/DecisionRecord/事件 outbox；UI 展示使用同一个不可变版本。

### 2.3

需求版本修订使旧执行批准失效，但不删除历史确认。只有展示性变化可不影响语义版本，需由确定性内容字段分类，不能由模型口头宣称无影响。

### 2.4

主 Agent 发起唯一待确认对象，用户确认需求之后展示流程选择；用户选择并提交启动动作可以作为明确启动授权。若已有流程预选，仅保留为候选，必须在确认后重新验证版本与角色映射。

### 2.5

工作流发布快照锁定 workflowId/version/hash；当前需求及已确认文档作为输入，不改节点顺序、分支条件和质量返工边。能力差异产生映射/成员确认，而不是主 Agent 临时生成一个替代图。

### 2.6

使用幂等 start request 与唯一运行关联，事务内绑定确认版本、WorkflowRun 记录和 outbox 启动命令；worker 按 request/run 唯一键领取。数据库事务重试不能直接执行模型或写工作区。

### 2.7

Web 与桌面复用 API/store/确认模型，独立页面布局保持不变。流程管理仍只读；右侧 Agent 任务和历史 Diff 复用现有入口，通知在群聊并保留现有扩展口，不新增强制外部通知。

## 3. 流转与失败边界

1. 讨论收敛 → 主 Agent 发布文档 vN → 用户查看 Diff → 确认当前版本。
2. 确认有效 → 用户选择已发布流程 → 校验映射/能力/目录/预算 → 原子创建运行 → worker 领取执行。
3. 文档修订 → 旧确认失效 → 新差异确认；质量拒绝 → 图内返工/有原因的等待 → 主 Agent 对接用户。

业务状态提交成功后才允许外部派发；事务重试回调仅做纯数据更新。任何失败都保留可定位的请求/需求/运行身份，不能用重复模型调用代替状态核对。

## 4. 数据与接口影响

- 扩展 brief/artifact 版本与 confirmation 绑定，正式需求文档状态不依赖聊天文字推断。
- 启动请求包含目标文档/需求/工作流版本及幂等键；API 明确 stale_confirmation、workflow_unavailable、capability_mapping_required 等候选错误语义，最终名称随合同冻结。

拟新增类型、状态和接口均为设计项，不是当前可调用 API。涉及持久化时，实施必须同步 shared、API/event/data/runtime/UI-state 合同、PostgreSQL projection/迁移和 file backend，不能只加内存 Map。

## 5. 修改边界

允许修改的候选落点（实施时按任务裁剪）：

- `apps/server/src/modules/sessions/`
- `apps/server/src/modules/orchestrator/`
- `apps/server/src/modules/artifacts/`
- `apps/server/src/modules/workflows/`
- `apps/server/src/modules/context-management/`
- `apps/server/src/modules/persistence/`
- `apps/web/src/stores/`
- `apps/web/src/components/`
- `apps/desktop/renderer/components/`
- `packages/shared/src/`

禁止修改：无关业务、项目凭据、用户授权目录、用户源码/未合并产物，以及非本阶段所需的全局页面样式。不将 Harness Engineering 新建为业务模块。

## 6. 实施次序与验证

按 [tasks](../implementation/main-agent-collaboration-phase-4-tasks-v1.md) 顺序推进，每项先补失败用例/合同断言，再实现并最小回归。完整场景和命令见 [checklist](../quality/main-agent-collaboration-phase-4-checklist-v1.md)；现有命令并不自动覆盖拟新增场景。

## 7. 风险、回退与未决参数

- 只检查 confirmationId 而不检查内容版本会批准过期需求。
- 流程下架、角色配置和目录授权可能在选中与启动之间变化，必须启动前再次核实。

回退：停止新确认/启动入口，保留已确认文档和已创建运行；运行继续使用锁定快照或停稳等待，禁止退回无版本约束的启动路径。

产品交互按总计划已沟通边界执行。模型预算、并发、缓存容量与 TTL 等环境参数不在文档中冒充现有配置；在阶段 0 冻结配置合同、相关阶段实现前记录有效值和验证依据。新增破坏性维护/外部服务采购/发布需单独确认，不影响本轮生成设计文档。
