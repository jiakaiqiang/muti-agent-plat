# 阶段 3：主 Agent 主持讨论与可恢复专家协作 — Plan v1

> 日期：2026-09-16
> 状态：设计与实施基线，待实施；现有能力的复用不代表本阶段验收已完成。
> 依赖：阶段 1、2A、2B、2C 通过；核心正确性不依赖缓存命中。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-3-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-3-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-3-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-3-checklist-v1.md)

## 1. 目标、依据与决策

用户提出需求后由主 Agent 主持，按需咨询专家、接收用户 @ 补充、处理分歧并统一给出综合方案与澄清问题。

当前依据见同阶段 Spec 第 3 节。已沟通决定统一见总计划，本文将其映射为实现边界。

方案选择：沿用现有领域模块与共享合同，增量补强；不新增平行编排/上下文系统。收益是保持现有 Runtime、流程图、双端状态和数据可追溯性；代价是必须覆盖旧入口并完成版本兼容验证。

## 2. 可执行设计

### 2.1

复用 coordinator 作为主 Agent，不新建另一个 Supervisor。主 Agent 通过结构化输出 propose_consultation/propose_question/propose_summary 提议，领域服务校验成员、工具策略、版本和预算后落实；不能让模型直接写业务状态。

### 2.2

拟新增 DiscussionRun/Topic/Delegation（先审查可扩展现有 task 的边界）：包含 sessionId/workItemId、requirementRevision、generation、parentDiscussionId、targetAgentId、objective、expectedResult、deadline、budget、operationId、status。避免把只读咨询伪装成已选择工作流节点。

### 2.3

讨论状态候选：planning → consulting → synthesizing → waiting_user / ready_for_confirmation；暂停/失败独立记录恢复检查点。委派状态候选：pending → running → completed/blocked/failed/cancelled/superseded。它们不是已存在的 SessionStatus 值。

### 2.4

首次需求由主 Agent 生成讨论计划，必要专家按只读能力并行执行；专家可请求补证或建议协助对象，但调度始终回主 Agent。已有 boundedConsultations 只作为执行器，持久化计划/唯一 reservation 是恢复真相。

### 2.5

用户 @ 与补充先持久化，主 Agent 收到明确目标；同版本无冲突补充可追加委派，目标/验收改变则生成新修订并标记旧结果 stale。不会为了每条状态询问取消全部正在进行的专家。

### 2.6

专家输出合同为结论、依据引用、风险、未决问题、建议动作，不要求或展示私有思考过程。主 Agent 形成实质综合结论；“已汇总”固定文案不能代替读取实际专家结果。

### 2.7

所有正式澄清卡由主 Agent 拥有 confirmation/request ID，专家缺信息先反馈主 Agent。讨论默认只读项目/检索/草稿 artifact 能力，禁止执行开发工具；最终生成文档与流程握手由阶段 4 接管。

## 3. 流转与失败边界

1. 用户需求 → 主 Agent 识别缺口 → 选择已有专家/请求新增成员 → 委派咨询 → 收集结论。
2. 用户 @ 补充 → 关联当前话题与版本 → 指定专家回复 → 主 Agent 纳入汇总。
3. 主 Agent 综合 → 有冲突/缺口则统一澄清 → 新一轮有界咨询；已收敛 → 阶段 4 文档与确认。

业务状态提交成功后才允许外部派发；事务重试回调仅做纯数据更新。任何失败都保留可定位的请求/需求/运行身份，不能用重复模型调用代替状态核对。

## 4. 数据与接口影响

- 拟扩展讨论事件：计划、委派状态、专家建议、主 Agent 综合、需用户澄清，均携带需求版本与来源 ID。
- shared API/store 统一讨论投影，各端只改必要内容展示，不统一成一套页面样式；工作流右侧群聊仍使用相同业务事件。

拟新增类型、状态和接口均为设计项，不是当前可调用 API。涉及持久化时，实施必须同步 shared、API/event/data/runtime/UI-state 合同、PostgreSQL projection/迁移和 file backend，不能只加内存 Map。

## 5. 修改边界

允许修改的候选落点（实施时按任务裁剪）：

- `apps/server/src/modules/orchestrator/`
- `apps/server/src/modules/agents/`
- `apps/server/src/modules/sessions/`
- `apps/server/src/modules/context-management/`
- `apps/server/src/modules/persistence/`
- `apps/web/src/stores/`
- `apps/web/src/components/`
- `apps/desktop/renderer/components/`
- `packages/shared/src/`

禁止修改：无关业务、项目凭据、用户授权目录、用户源码/未合并产物，以及非本阶段所需的全局页面样式。不将 Harness Engineering 新建为业务模块。

## 6. 实施次序与验证

按 [tasks](../implementation/main-agent-collaboration-phase-3-tasks-v1.md) 顺序推进，每项先补失败用例/合同断言，再实现并最小回归。完整场景和命令见 [checklist](../quality/main-agent-collaboration-phase-3-checklist-v1.md)；现有命令并不自动覆盖拟新增场景。

## 7. 风险、回退与未决参数

- 只修改提示词无法获得可靠调度和恢复，必须以持久化计划为准。
- 过多主 Agent/路由模型调用可能抵消裁剪收益，路由结论应复用，简单动作走确定性路径。

回退：仅关闭新讨论准入；已建立的新讨论对象在停稳后等待用户或由兼容构建恢复。不能将未完成讨论直接转成旧流程执行。

产品交互按总计划已沟通边界执行。模型预算、并发、缓存容量与 TTL 等环境参数不在文档中冒充现有配置；在阶段 0 冻结配置合同、相关阶段实现前记录有效值和验证依据。新增破坏性维护/外部服务采购/发布需单独确认，不影响本轮生成设计文档。
