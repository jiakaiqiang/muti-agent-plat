# Context Pipeline v2 单轨与历史会话处理需求文档 v1

> 日期：2026-07-12
> 状态：v2-only 需求决策已确认，系统设计与开发文档已形成并正在实施；真实数据切换尚未授权
> 需求类型：架构收敛、Agent 解耦、历史会话退场
> 上游设计：[`../agent-task/system-design.md`](../agent-task/system-design.md)
> 当前闭环方案：[`../design/workspace-aware-context-v2-integration-closure-v1.md`](../design/workspace-aware-context-v2-integration-closure-v1.md)

## 1. 背景

当前系统曾同时存在两套执行语义：

- v1/旧语义：Session 创建时固化 Runtime/Model，并允许 Session 或 Agent Runtime override 影响实际执行。
- v2/目标语义：Agent 只定义角色、Profile、Skill、Tool 和能力约束；每次调用由任务、阶段、Workspace 能力、策略和 Runtime 可用性动态解析执行目标。

v2 主链路已经具备 Context Envelope、动态 Runtime 路由、Workspace Provider、Browser Broker、证据门禁和补读重试等实现基础。继续保留历史兼容分支会造成两套行为长期并存，并使 Agent 解耦无法形成唯一系统语义。

用户已经提出：当前历史会话不做兼容处理。该决定需要先转化为明确的产品和数据边界，再继续修改代码。

## 2. 目标

### 2.1 产品目标

- 系统最终只保留 Context Pipeline v2 主链路。
- Agent 不直接绑定或决定实际 Runtime/Model。
- Runtime 选择在每次调用时动态完成，并可审计、可解释、能力不足时 fail closed。
- 历史会话不触发 v1 Runtime/Model、Agent override 或旧 Context payload 兼容逻辑。
- 切换时从活动数据集删除全部历史 Session 及其关联旧数据，不迁移、不提供兼容读取；替换前生成外部加密只读审计归档。

### 2.2 工程目标

- 删除 v1/v2 运行时条件分支，而不是把 v1 分支隐藏在默认值或 fallback 中。
- `ContextEnvelopeV2` 成为 Runtime 唯一权威上下文载荷。
- `ResolvedExecutionTarget` 成为实际 Runtime/Model 的唯一审计结果。
- 合同、Health、Debug、前端展示、测试和 Harness 文档只描述一种执行语义。

## 3. 非目标

- 本需求不要求保留历史会话的继续执行能力。
- 本需求不提供 v1 到 v2 的自动内容迁移、任务续跑或状态恢复。
- 本需求不提供历史会话的在线查看、导出或恢复能力；外部加密归档仅供获批的离线审计。
- 本需求不改变真实 Codex/Claude/GLM 的外部凭据和发布门禁。
- 本需求不为历史原始数据开发 deprecated 字段清洗程序；历史数据整体删除，当前活动 Agent 合同和 Runtime 身份合同直接使用新字段。

## 4. 术语与范围

### 4.1 v2 Session

满足当前 v2 合同，并且执行时使用 Context Envelope、动态路由和 Workspace Plane 的 Session。

### 4.2 历史会话

历史会话范围已经确认采用 H2：v2 单轨版本切换生效前已经存在的全部 Session，无论其原版本字段是 `v1`、`v2` 还是缺失。

| 选项 | 定义 | 决策 |
| --- | --- | --- |
| H1 | 仅 `contextPipelineVersion='v1'` 或缺失版本的 Session | 不采用 |
| H2 | 切换时间点之前创建的全部 Session | **已确认**：所有现有会话均退出，只允许切换后新建会话进入 v2 主链路 |

切换生效点必须由部署或启用动作记录明确时间戳；不能依赖历史 Session 自身的 Pipeline 字段判断。

### 4.3 不兼容

“不兼容”至少包含以下强制语义：

- 不执行 v1 Orchestrator 分支。
- 不读取旧 Session 固定 Runtime/Model 作为实际执行结果。
- 不读取 Agent `runtimeType/modelId` 作为实际执行结果。
- 不为历史会话补造 Context Envelope 后继续原任务。
- 不保证历史任务、运行中状态、补充上下文和 Runtime session 可以恢复。

“不兼容”同时表示产品内不可查看、不可导出、不可恢复，并在切换时从活动数据集中删除历史业务数据。

## 5. 目标行为

### R-01 v2 单轨执行

- 新建 Session 必须使用 v2。
- Orchestrator 必须无条件构建 `ContextEnvelopeV2`。
- Runtime 调用必须无条件执行动态目标解析。
- 系统不得通过 `CONTEXT_PIPELINE_V2_ENABLED=false` 恢复 v1 行为。
- 如果保留版本字段，其唯一合法值为 `v2`；如果后续删除版本字段，也不得重新引入运行时分流。

### R-02 Agent 与 Runtime 解耦

- Agent Profile 只负责角色、指令、Skill、Tool、知识和 Capability 声明。
- Agent `runtimeType/modelId` 即使存在于历史数据中，也不得参与执行目标解析。
- Agent 切换 Runtime 后，其身份、角色、Skill 和 Capability 必须保持不变。
- Session 或项目级设置只能作为路由偏好或策略输入，不能绕过能力、Workspace 和安全检查。

### R-03 动态 Runtime 路由

- 每次调用根据任务类型、执行阶段、所需能力、Workspace Provider、策略和已注册 Runtime 解析目标。
- 解析结果必须写入 `ResolvedExecutionTarget`，包含来源和原因。
- 无 eligible Runtime 时必须返回 `CAPABILITY_BLOCKED`，不得静默回退到不满足能力的 Runtime。
- 浏览器工作区只允许满足其能力边界的降级，不得获得命令执行能力。

### R-04 Context v2 唯一载荷

- Runtime 只以 L0-L6 `ContextEnvelopeV2` 作为权威上下文。
- `workspaceSnapshot`、`workspaceManifest`、`selectedEvidenceContents` 和 `projectMap` 只允许用于 Envelope 组装，不得与 Envelope 重复发送到 Runtime。
- 代码实现或架构分析缺少有效证据时必须返回 `CONTEXT_INSUFFICIENT`。
- Workspace Provider 补读后必须重建 Envelope，再重试同一阶段。

### R-05 历史会话运行行为

- 命中“历史会话”定义的 Session 不得继续进入讨论、Brief、执行、Review、Rework 或 Delivery 主链路。
- 不得把旧 Session 在内存中静默改写为 v2 后继续执行。
- 不得用默认值掩盖缺失的历史版本或旧运行时字段。
- API 和 UI 必须提供确定、一致、可测试的结果，具体结果由 D-02 决定。

### R-06 历史数据安全

- v2 单轨切换必须显式删除全部历史 Session 及其关联事件、任务、Brief、产物、记忆、补充上下文、Runtime invocation 和恢复状态。
- 不为历史数据创建迁移副本、在线归档、导出包或兼容存储分区；只允许活动根之外的加密只读审计归档。
- 删除前必须执行只读 dry-run，输出各集合数量、关联完整性、存储位置和预计删除范围；不得输出业务正文或密钥。
- 删除必须幂等，并保证不会删除切换生效后创建的新 v2 数据。
- 支持事务的存储必须在事务内完成；文件存储必须先建立新的空 v2 数据集并成功切换，再删除旧数据，避免产生新旧混合状态。
- 切换后活动数据只保留不含业务正文的审计摘要：切换时间、系统版本、删除集合、数量、归档密文 hash/bytes、执行结果和操作者。
- 需求确认不等于立即执行删除；实际切换和删除仍需单独的高风险操作确认。

### R-07 API 与前端

- 新建会话不再提供 v1 选择或 v2 feature flag。
- Health 只报告当前实际 Pipeline，不展示可切回 v1 的含义。
- Debug 不得显示历史 Agent override 是当前实际路由来源。
- 历史会话在列表、详情和操作入口中的行为必须与 D-02 一致。

### R-08 Agent Profile、Skill 与 Tool 真正解耦

- Agent 持久化定义和编译后身份中不得包含实际执行用的 `runtimeType`、`modelId` 或 `runtimeSelection`；执行目标只能存在于 Invocation 侧的 `ResolvedExecutionTarget`。
- `AgentProfileCompiler` 是 Profile Markdown 的唯一权威编译入口，支持 `${skill:stable-key}` 和 `${tool:stable-key}`。
- Skill 引用必须解析为已启用 Skill 的内容、文件、稳定 ID、稳定 key 和 revision，并进入统一 `systemPrompt` 与 Invocation 快照。
- Tool 引用必须解析为稳定 Tool/Capability ID 和 key；未知、禁用、未配置、内部不可插入或未授权引用必须 fail closed。
- Tool 引用只表达“希望使用”，不得自动授予权限。真实可调用工具集合必须取以下交集：Profile Tool 引用、Agent `capabilityIds`、阶段策略、Workspace Provider 能力、Runtime Adapter 能力和人工审批结果。
- 编译得到的 `toolIds` 必须驱动真实 `ResolvedToolCatalog`，不能只把 Tool 说明文字展开进 Prompt。
- Generic LLM、Codex、Claude Code 及其他 Runtime 可以使用不同适配器协议，但必须消费同一个编译后 Agent 身份、Skill 快照、Tool Catalog 和执行目标合同。
- Runtime 切换时只替换 `ResolvedExecutionTarget` 和适配器，不得改变 Agent 的角色、Profile、Skill、Tool 意图、Capability 或知识绑定。
- Invocation 审计必须分别记录 `agentProfileHash`、Skill ID/revision、Tool ID、Capability 决策和 `ResolvedExecutionTarget`，证明身份与执行环境相互独立。

## 6. 历史会话产品策略候选

| 方案 | 列表可见 | 详情可见 | 可导出 | 可继续执行 | 自动删除 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| S1 完全隐藏、数据保留 | 否 | 否 | 仅离线 | 否 | 否 | 不采用 |
| S2 归档只读 | 是，标记归档 | 是，只读 | 是 | 否 | 否 | 提供数据查看能力，但需要额外只读产品实现 |
| S3 明确拒绝 | 可选 | API 返回明确错误 | 可选 | 否 | 否 | 可使用 `410 Gone` 或业务错误码表达已退役 |
| S4 清理历史数据 | 否 | 否 | 否 | 否 | 是 | 已被 S5 覆盖 |
| S5 活动清理 + 离线审计归档 | 否 | 否 | 仅获批离线审计 | 否 | 是 | **最终确认**：活动数据零保留，外部加密只读归档不可恢复 |

当前最终采用 S5。新系统只包含切换后创建的 v2 数据，不提供任何历史数据入口；外部归档不属于产品数据面。

## 7. 决策记录

### D-01 历史会话判定范围（发布阻断）

**已确认：选择 H2。**

- v2 单轨切换生效前存在的全部 Session 都属于历史会话。
- 不区分这些 Session 原来记录的是 v1、v2 还是缺失版本。
- 所有历史会话均不得继续进入新系统运行链路。
- 切换生效时间必须形成可审计记录，作为新旧 Session 的唯一边界。

### D-02 历史会话访问方式（发布阻断）

**最终确认：选择 S5，覆盖此前的 S1/S4 决策。**

- 历史会话不出现在产品列表中。
- 产品 UI 和常规详情 API 不提供历史会话访问入口。
- 历史会话不能继续执行、恢复、重试或迁移。
- 切换时从活动数据集删除历史会话及其全部关联业务数据，不提供产品内只读、导出或恢复入口。
- 替换前生成活动根之外的加密只读归档，只允许获批的离线审计，不允许导入或 Resume。
- 活动数据只保留不含业务正文的删除与归档 hash 审计摘要。

### D-03 运行中会话处理（发布阻断）

**已确认：统一终止并记录系统升级退役审计。**

- 切换时处于 `AGENT_DISCUSSING`、`EXECUTING`、`REWORKING`、`WAIT_*` 或其他未完成状态的历史会话全部终止。
- 终止原因统一记录为“Context Pipeline v2 单轨升级，历史会话退役”。
- 必须生成离线审计记录，至少包含 Session ID、切换时间、终止前状态、活动 Task/Runtime、终止原因和操作版本。
- 不触发 Runtime 重试、任务重排、恢复队列、自动返工或 Session Resume。
- 正在运行的 Runtime 必须收到取消信号并受限时退出；超时未退出时记录进程清理结果。
- 退役处理不得把历史会话转换为普通 `FAILED` 后重新进入现有失败恢复链路。

### D-04 数据保留与只读归档

**最终确认：活动数据零保留，切换前生成外部加密只读归档。**

- v2 单轨切换生效时从活动数据集中删除全部历史业务数据，不设置兼容读取或恢复分支。
- apply 在替换活动 state 前，必须把旧 state 写入活动数据根目录之外的 AES-256-GCM 加密只读归档，并生成不含业务正文的 manifest（revision、集合计数、密文 SHA-256 和字节数）。
- 归档不能被 Session API、Recovery、Queue、Browser Broker 或 Runtime Resume 加载；它只供获批的离线审计使用，旧会话永远不能恢复运行。
- archive/key 缺失、归档位于活动数据根内、写入不完整或校验冲突时，cutover 必须在替换活动 state 前失败。
- dry-run 报告归档目录和删除范围；apply 仍需高风险操作确认。归档保留/销毁由独立运维审批管理，不由应用自动执行。

### D-05 deprecated 字段清理

**已确认：全部采用新合同，不保留旧字段兼容。**

- 当前活动 Agent 合同和 Runtime 身份合同按 R-08 移除 `runtimeType/modelId/runtimeSelection` 执行选择字段。
- Session、API、Health、Debug、持久化和前端只使用新合同。
- 不开发旧字段读取、默认值回填、数据迁移或逐字段清洗逻辑。
- 历史原始数据在切换时整体删除，因此无需保留或转换 `Agent.runtimeType/modelId` 和旧 Session override 字段。

## 8. 验收标准

- 合同只允许系统确认的唯一 Pipeline 行为。
- 任意环境变量都不能恢复 v1 执行路径。
- Runtime 调用均包含 `contextEnvelopeV2` 和 `resolvedExecutionTarget`。
- Agent `runtimeType/modelId` 改变不会改变动态路由结果。
- Agent 持久化合同和 Runtime 身份合同不再拥有实际 Runtime/Model 选择字段。
- `${skill:key}` 能展开内容并记录 revision；修改 Skill 后新 Invocation 使用新 revision，历史 Invocation 快照保持可追溯。
- `${tool:key}` 只有在 Tool 引用、Capability、阶段、Workspace、Runtime 和审批全部允许时才进入真实 Tool Catalog。
- 同一个编译后 Agent 分别切换两个 eligible Runtime 时，Profile hash、Skill/Tool/Capability 集合保持一致，只有 `ResolvedExecutionTarget` 改变。
- 无 eligible Runtime 时稳定返回 `CAPABILITY_BLOCKED`。
- 历史会话无法进入任何运行阶段，并按 D-02 返回一致结果。
- 所有未完成历史会话在切换时被终止，具有完整退役审计，且不会产生重试、Resume 或恢复任务。
- 历史业务数据从活动数据集全部删除；仅生成活动数据根之外的加密只读审计归档，不产生可恢复 Session 或兼容数据副本。
- 历史数据只能由显式 cutover apply 删除；普通加载、启动和持久化不得提前或重复误删数据。
- `npm run typecheck`、`npm run test`、`npm run test:harness`、`npm run build` 全部通过。
- v2 主链路、动态路由、历史会话拒绝、Context 补读和 v1 feature flag 失效均有自动化测试。

## 9. 当前工作区状态说明

在本需求文档形成前，工作区中已经出现一组未提交、未完成验证的“v2 单轨”部分修改，涉及共享合同、Session 创建、Health、Orchestrator、前端版本展示和相关测试。

这些修改不代表需求已经确认或实现已经完成。继续实现前必须：

1. 根据已确认的 D-01～D-05 审查当前部分修改是保留、调整还是回退。
2. 先更新系统设计和验收矩阵，再继续代码修改。
3. 未经单独的高风险操作确认，不执行历史数据删除、提交或部署。

## 10. 决策结论与下一步

D-01～D-05 已全部确认：所有现有 Session 都是历史会话；切换时终止运行、从活动数据集中删除全部历史业务数据并生成外部加密只读归档；不迁移、不恢复、不保留旧合同兼容；新系统只使用 v2、解耦 Agent Profile、Skill、Tool Catalog 和动态 Runtime 路由。

系统设计、实现和空 v2 状态全链路验收已经完成，完整质量门已通过。真实数据 cutover apply、提交和部署仍分别按其风险边界获得授权后执行；未经独立确认不会删除当前数据。
