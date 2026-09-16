# 阶段 2C：分层缓存、失效治理与成本观测 — Plan v1

> 日期：2026-09-16
> 状态：设计与实施基线，待实施；现有能力的复用不代表本阶段验收已完成。
> 依赖：阶段 2A、2B 通过；所有缓存必须服从阶段 1 生命周期。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-2c-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-2c-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-2c-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-2c-checklist-v1.md)

## 1. 目标、依据与决策

减少重复检索、解析、摘要和模型前缀计算，同时保证缓存不串会话、不覆盖新需求、不掩盖真实 Token 使用。

当前依据见同阶段 Spec 第 3 节。已沟通决定统一见总计划，本文将其映射为实现边界。

方案选择：沿用现有领域模块与共享合同，增量补强；不新增平行编排/上下文系统。收益是保持现有 Runtime、流程图、双端状态和数据可追溯性；代价是必须覆盖旧入口并完成版本兼容验证。

## 2. 可执行设计

### 2.1

缓存边界：文件解析以 workspaceId+path+contentHash+parserVersion；摘要以 session/workItem+coveredSeq+事实版本+summaryPolicy；上下文包以需求/角色/目标+查询 hash+依赖指纹。Provider cache 由 adapter 能力声明控制，不等同平台 Redis/内存缓存。

### 2.2

共享内容只允许无会话隐私的角色模板、工具 schema 与已授权项目规则。用户/租户权限上线前不伪称租户安全已实现；当前仍严格执行会话归属、目录授权和 Tool Authority，未来 actorScope 可加入 key。

### 2.3

读取验证依赖与墓碑；构建完成回填前再次比较 generation/内容版本。single-flight 仅解决进程内竞争，跨实例使用短租约+唯一键/CAS；失去所有权的构建结果不可覆盖当前值。

### 2.4

运行时组装稳定规则/工具在前，当前消息与变动证据在后，不为命中率把不可信文本升级为 system。模型/工具/schema 变化时按 adapter 规则失效；不得添加无用文本只为达到缓存门槛。

### 2.5

缓存能力配置采用 supported/unsupported/unknown 及厂商/模型/端点绑定；实施时核对该组合的官方文档并用受控请求验证。TTL、参数、阈值和计费不跨供应商硬编码；CLI 内建缓存不能假定平台可直接控制。

### 2.6

缓存失效逻辑先保证正确性，再优化命中。摘要压缩可能降低旧前缀复用，比较总费用与任务质量；本地 invalidation 不能宣称即时清除厂商缓存，厂商保留由其支持的策略决定。

### 2.7

用量模型区分原始 provider usage、归一化 logicalInput、uncached/cacheRead/cacheWrite、output、estimated/actual、priceVersion。事件按 attemptId 幂等结算，不将缓存 Token 与已经包含它们的 input 总量重复相加。高基数会话 ID 仅进 trace，不作为无限增长的 metrics 标签。

## 3. 流转与失败边界

1. 查询 key 与依赖 → 校验作用域/墓碑 → 命中返回或有限回源 → 回填前版本复核。
2. 组装真实请求 → 2A 预算检查 → adapter 缓存参数 → 模型调用 → 原始用量归一化/幂等结算。
3. 需求/文件/策略变更 → 发布依赖失效 → 相关项淘汰；生命周期删除 → 私有召回/缓存立即不可见。

业务状态提交成功后才允许外部派发；事务重试回调仅做纯数据更新。任何失败都保留可定位的请求/需求/运行身份，不能用重复模型调用代替状态核对。

## 4. 数据与接口影响

- 拟增加 RuntimeCacheCapabilities、CacheDependencyFingerprint、UsageBreakdown 与摘要构建锁字段；复用现有缓存读写字段并补兼容默认 unknown。
- 缓存配置作为有限大小、TTL、构建并发、降级策略的版本化配置；私有正文、凭据和完整提示词不写 metrics/log。

拟新增类型、状态和接口均为设计项，不是当前可调用 API。涉及持久化时，实施必须同步 shared、API/event/data/runtime/UI-state 合同、PostgreSQL projection/迁移和 file backend，不能只加内存 Map。

## 5. 修改边界

允许修改的候选落点（实施时按任务裁剪）：

- `apps/server/src/modules/workspaces/`
- `apps/server/src/modules/memory/`
- `apps/server/src/modules/context-v2/`
- `apps/server/src/modules/runtimes/`
- `apps/server/src/common/workspace-metrics.ts`
- `packages/shared/src/runtime-streaming/`
- `packages/local-runtime-cli/src/`

禁止修改：无关业务、项目凭据、用户授权目录、用户源码/未合并产物，以及非本阶段所需的全局页面样式。不将 Harness Engineering 新建为业务模块。

## 6. 实施次序与验证

按 [tasks](../implementation/main-agent-collaboration-phase-2c-tasks-v1.md) 顺序推进，每项先补失败用例/合同断言，再实现并最小回归。完整场景和命令见 [checklist](../quality/main-agent-collaboration-phase-2c-checklist-v1.md)；现有命令并不自动覆盖拟新增场景。

## 7. 风险、回退与未决参数

- 缓存命中率上升不等于总成本下降，摘要生成/写缓存费用和更多调用必须一起统计。
- 不同 provider 的 input_tokens 是否含缓存部分不同，必须按实际响应合同归一化。

回退：按缓存层单独停用并回源，保留需求隔离、预算、墓碑和用量记录。停用提示词缓存不改变模型输入语义；不清除业务原始记录。

产品交互按总计划已沟通边界执行。模型预算、并发、缓存容量与 TTL 等环境参数不在文档中冒充现有配置；在阶段 0 冻结配置合同、相关阶段实现前记录有效值和验证依据。新增破坏性维护/外部服务采购/发布需单独确认，不影响本轮生成设计文档。
