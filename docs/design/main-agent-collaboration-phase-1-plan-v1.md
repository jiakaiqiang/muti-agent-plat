# 阶段 1：多会话执行隔离、停止与可恢复删除 — Plan v1

> 日期：2026-09-16
> 状态：设计与实施基线，待实施；现有能力的复用不代表本阶段验收已完成。
> 依赖：阶段 0 通过。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-1-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-1-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-1-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-1-checklist-v1.md)

## 1. 目标、依据与决策

同一 Agent 服务多个会话时，停止或删除其中一个只影响目标会话；未知停止状态不得伪装成功，删除不损毁源码或未合并产物。

当前依据见同阶段 Spec 第 3 节。已沟通决定统一见总计划，本文将其映射为实现边界。

方案选择：沿用现有领域模块与共享合同，增量补强；不新增平行编排/上下文系统。收益是保持现有 Runtime、流程图、双端状态和数据可追溯性；代价是必须覆盖旧入口并完成版本兼容验证。

## 2. 可执行设计

### 2.1

复用 SessionStopStateStore、LogicalOperationStore 和 scoped mutation，将暂停/删除的准入关闭与 generation 更新置于同一事务。停止目标与启动 reservation 使用相同作用域锁，外部取消在提交之后执行，不放进事务重试回调。

### 2.2

拟增加独立 SessionLifecycle 记录或字段（active/deleting/deleted、generation、deleteRequestId、deletedAt、lastError）；不把这些业务生命周期直接混入模型任务状态枚举。墓碑在重启恢复、队列领取、缓存读取和所有结果提交入口共同检查。

### 2.3

未来阶段 2B 摘要、阶段 3 委派、阶段 5 变更任务注册为会话所有的受管工作；阶段 1 提供统一注册/取消/准入接口。取消只针对归属明确的 invocation/process group；禁止按共享父进程或 agentId 杀进程。

同一 Agent 配置允许多个独立实例，但不意味着底层模型/设备无限并发。设备、模型端点和 CLI 的容量限制由调度层排队处理，队列项仍绑定 sessionId/operationId；停止 A 只取消 A 的排队项和资源预留，不能清空 B 的队列。运行开始时固化 Profile/Runtime 策略版本，管理员修改共享 Agent 定义不改变已运行实例的输入。

### 2.4

删除入口保持幂等语义；响应区分 deleting/blocked/deleted 并返回同一 requestId，前端用快照+SSE 展示。实际 API schema 和 HTTP 状态在阶段 0 合同评审确定，不用 deleted:true 表示尚未停稳。

### 2.5

现有目录删除和 deleteSessionData 从普通用户删除路径移出；新增数据保留策略只控制隐藏与派生缓存，不进行自动 purge。物理清理是后续独立、显式授权的维护操作，本阶段没有定时清理器。

### 2.6

恢复前核对可信停止证据及文件/目录仍可访问；恢复为暂停态并提高 generation。文件已被外部移动则显示阻塞，不默默重建源目录，不重播副作用。

## 3. 流转与失败边界

1. 停止：active → 准入关闭 → 固定调用目标 → 取消 → 等待可信回执/落库 → paused。
2. 删除：active/paused → deleting（立即停止新任务）→ 停稳与数据保留成功 → deleted（列表隐藏）。
3. 阻塞/恢复：deleting + unknown 保留状态 → 核对后继续删除；deleted → 用户恢复 → paused → 用户显式继续。

业务状态提交成功后才允许外部派发；事务重试回调仅做纯数据更新。任何失败都保留可定位的请求/需求/运行身份，不能用重复模型调用代替状态核对。

## 4. 数据与接口影响

- 扩展停止/删除查询、恢复操作和 UI-state，事件携带 sessionId、generation、requestId、version。
- PostgreSQL 与 file 持久化生命周期/墓碑；事务失败不发布完成事件；沿用 outbox 去重。

拟新增类型、状态和接口均为设计项，不是当前可调用 API。涉及持久化时，实施必须同步 shared、API/event/data/runtime/UI-state 合同、PostgreSQL projection/迁移和 file backend，不能只加内存 Map。

## 5. 修改边界

允许修改的候选落点（实施时按任务裁剪）：

- `apps/server/src/modules/sessions/`
- `apps/server/src/modules/runtimes/`
- `apps/server/src/modules/local-runtime/`
- `apps/server/src/modules/execution/`
- `apps/server/src/modules/queue/`
- `apps/server/src/modules/persistence/`
- `packages/local-runtime-cli/src/`
- `apps/web/src/stores/`
- `apps/desktop/renderer/components/`

禁止修改：无关业务、项目凭据、用户授权目录、用户源码/未合并产物，以及非本阶段所需的全局页面样式。不将 Harness Engineering 新建为业务模块。

## 6. 实施次序与验证

按 [tasks](../implementation/main-agent-collaboration-phase-1-tasks-v1.md) 顺序推进，每项先补失败用例/合同断言，再实现并最小回归。完整场景和命令见 [checklist](../quality/main-agent-collaboration-phase-1-checklist-v1.md)；现有命令并不自动覆盖拟新增场景。

## 7. 风险、回退与未决参数

- 旧代码继续调用物理删除会破坏恢复保证，必须覆盖所有删除入口和清理 worker。
- 只依赖进程内 Map 的删除标识不能抵御重启或多实例。

回退：发现隔离/删除问题先停用新的删除/启动入口，保留墓碑与未知停止屏障。不能回退到物理删除路径处理新生命周期记录；需兼容构建或向前修复。

产品交互按总计划已沟通边界执行。模型预算、并发、缓存容量与 TTL 等环境参数不在文档中冒充现有配置；在阶段 0 冻结配置合同、相关阶段实现前记录有效值和验证依据。新增破坏性维护/外部服务采购/发布需单独确认，不影响本轮生成设计文档。
