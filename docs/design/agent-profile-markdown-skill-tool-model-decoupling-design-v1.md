# Agent Profile Markdown、Skill/Tool 编排与模型解耦技术方案 v1

> 最后修改时间：2026-07-11
> 修改人：Claude
> 修改的 Agent：Claude
> 状态：方案已确认 / 已按 TDD 实施后端合同+编译器+模型解绑与前端编辑器（待完整验证矩阵）

> **覆盖说明（2026-07-12）**：本文关于 Session 固化 Runtime/Model、旧 Agent/Session 兼容、迁移和 Tool 仅提示注入的设计已被 [`context-pipeline-v2-only-agent-decoupling-system-design-v1.md`](context-pipeline-v2-only-agent-decoupling-system-design-v1.md) 覆盖。Profile 引用语法和编译器既有实现仍作为参考，冲突时以新设计为准。

## 1. 文档目标

本文档定义 Agent Cluster 当前阶段的 Agent 能力编辑、Skill/Tool 编排和模型解耦方案。

目标是将 Agent 改造成与模型无关的可复用能力资产：

```text
Agent = Markdown 角色描述 + Skills + Tools + 权限
Session = 本次选择的 Agent + 统一 Runtime/模型
```

本期支持单 Agent 对话和多 Agent 群聊；一个 Session 内所有参与 Agent 共用创建 Session 时选择的 Runtime/模型。

## 2. 已确认范围

### 2.1 本期实现

- Agent 创建和编辑统一使用 Markdown 编辑器。
- Skill/Tool 支持多选、查看说明、点击插入和拖拽插入。
- Markdown 支持 `${skill:key}`、`${tool:key}` 引用。
- Skill 和 Tool 在各自管理入口维护。
- Agent 与具体模型、Runtime 解绑。
- 创建群聊时统一选择 Runtime/模型。
- 选择一个 Agent 时形成单 Agent 对话。
- 选择多个 Agent 时沿用现有群聊、任务契约、执行、复盘和交付链路。

### 2.2 本期不实现

- Scenario。
- Autopilot 改造。
- Agent A 引用或调用 Agent B。
- 每个 Agent 单独选择 Runtime/模型。
- 可视化工作流。

### 2.3 Harness Engineering 边界

本方案属于 Agent Cluster 的产品功能设计，落点是 Agent、Skill、Capability、Session、Runtime 和前端管理模块。

Harness Engineering 继续负责工具风险治理、人工确认和交付纪律，不把本方案反向定义成 Harness 本体能力。

## 3. 当前系统现状

当前系统已经具备部分基础：

- `Agent.profileMarkdown` 已存在，并作为 Runtime Agent Profile 的系统提示词来源。
- Skill 已有 CRUD、Agent `skillIds` 绑定和 ContextPack/Workdir Brief 注入。
- Capability 已有注册、风险等级、调用检查和审批。
- 创建 Session 时已经支持选择 `agentIds` 和 Session Runtime。
- Generic LLM 已支持运行时模型配置和全局模型切换。
- Codex/Claude 已接入统一 Runtime Adapter 和 Workdir Brief。

当前主要缺口：

- `Agent` 仍包含 `modelId/runtimeType`，运行时会优先使用 Agent 自身配置。
- Agent 创建/编辑页没有完整的 Markdown 和 Skill 编辑能力。
- Markdown 编辑入口位于模型管理页，职责混杂。
- Tools 页面目前主要是只读展示。
- Skill 当前额外追加到 `systemRules`，没有占位符编译和插入位置控制。
- 不同 Runtime 存在 Skill/Profile 重复注入或遗漏的风险。

主要现有落点：

- `packages/shared/src/contracts.ts`
- `apps/server/src/modules/agents/`
- `apps/server/src/modules/skills/`
- `apps/server/src/modules/capabilities/`
- `apps/server/src/modules/sessions/`
- `apps/server/src/modules/orchestrator/`
- `apps/server/src/modules/runtimes/`
- `apps/web/src/components/AgentManager.vue`
- `apps/web/src/components/SkillManager.vue`
- `apps/web/src/components/RuntimeModelManager.vue`
- `apps/web/src/components/SessionWorkspace.vue`

## 4. 目标架构

```text
Agent Definition
  ├─ Markdown Profile
  ├─ Skill References
  ├─ Tool References
  └─ Capability Permissions

Session
  ├─ Participating Agent IDs
  ├─ User Task
  └─ Shared Execution Target
       ├─ Runtime Type
       └─ Model ID

Runtime Invocation
  ├─ Compiled Agent Profile
  ├─ Resolved Skills
  ├─ Resolved Tools
  ├─ ContextPack
  └─ Audit Snapshot
```

设计原则：

- Agent 只描述“是谁、会什么、允许使用什么”。
- Session 决定“本次使用什么 Runtime/模型”。
- Profile 编译器是引用解析的唯一权威入口。
- Tool 引用不等于权限授予。
- Skill/Tool 管理和 Agent 编辑共享同一资源注册表。
- 同一个 Session 内执行目标保持稳定。

## 5. 数据模型

### 5.1 Agent Definition

目标 Agent 类型：

```ts
type Agent = {
  id: string
  key: string
  name: string
  role: string
  description?: string
  profileMarkdown: string
  tags: string[]
  status: 'active' | 'disabled'

  skillIds: string[]
  capabilityIds: string[]
  defaultKnowledgeBaseIds: string[]

  createdAt: string
  updatedAt: string

  /** 兼容期保留，禁止新数据继续写入。 */
  modelId?: string
  /** 兼容期保留，禁止新数据继续写入。 */
  runtimeType?: RuntimeType
}
```

约束：

- 新建和编辑 Agent 时不再配置 `modelId/runtimeType`。
- `modelId/runtimeType` 分阶段废弃，兼容旧 Session 恢复。
- `profileMarkdown` 是 Agent 角色能力描述的主文档。
- `skillIds` 由 Markdown Skill 引用派生并物化保存。
- `capabilityIds` 是能力权限列表，不能仅靠 Markdown Tool 引用生成。

### 5.2 Session Execution Target

```ts
type ExecutionTarget = {
  runtimeType: RuntimeType
  modelId?: string
}

type SessionDetail = {
  // 其他现有字段
  executionTarget: ExecutionTarget
}
```

规则：

- `generic_llm` 可以携带 `modelId`。
- `codex/claude_code` 本期使用 Runtime 自身配置，暂不从统一模型管理中选择具体模型。
- Session 创建时解析并固化最终 `executionTarget`。
- 全局默认模型后续变化不影响已经创建的 Session。
- 一个 Session 内所有参与 Agent 共用该执行目标。

### 5.3 Skill

在现有 Skill 上增加稳定引用和版本信息：

```ts
type Skill = {
  id: string
  key: string
  name: string
  description?: string
  content: string
  files: SkillFile[]
  status: 'active' | 'disabled'
  revision: number
  createdAt: string
  updatedAt: string
}
```

约束：

- `key` 创建后不可修改。
- Skill 改名不影响 Agent Markdown 引用。
- 每次内容修改增加 `revision`。
- Skill 不允许保存密钥或不应注入 Runtime 的敏感内容。

### 5.4 Tool/Capability

现有 Capability Registry 需要区分内部能力和可插入工具：

```ts
type CapabilityKind = 'internal' | 'tool' | 'mcp' | 'connector'

type CapabilityDefinition = {
  id: string
  key: string
  kind: CapabilityKind
  name: string
  descriptionMarkdown?: string
  usageMarkdown?: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  riskLevel: 'low' | 'medium' | 'high'
  status: 'active' | 'disabled' | 'unconfigured'
  systemOwned: boolean
}
```

约束：

- `internal` 能力不允许通过 `${tool:key}` 插入。
- 内置 Tool 的执行器、风险等级和 `key` 受保护。
- 自定义 Tool 没有执行适配器时只能处于 `unconfigured`。
- Tool 占位符不授予权限，Agent 仍必须拥有对应 `capabilityIds`。
- 高风险 Tool 继续经过现有 Capability 审批流程。

## 6. Markdown 引用协议

示例：

```md
# 前端开发 Agent

## 工作职责

负责 Vue 页面、组件和状态管理实现。

## 专项技能

${skill:element-plus-ui}

## 可用工具

${tool:file-write}
${tool:command-run}
```

语法规则：

- Skill：`${skill:stable-key}`
- Tool：`${tool:stable-key}`
- 转义：`\${skill:example}`
- Markdown 代码块和行内代码中的占位符不解析。
- 不存在或已禁用的资源阻止保存。
- 同一个引用重复出现时产生错误或警告。
- 引用顺序决定 Skill/Tool 说明在最终 Profile 中的出现顺序。

### 6.1 多选与 Markdown 同步

- 点击选择 Skill 时，在当前光标位置插入引用。
- 未激活编辑光标时，插入到 `## 专项技能` 区域。
- 对应区域不存在时自动创建。
- 取消选择 Skill 时删除对应引用。
- Tool 选择同时更新 `capabilityIds`，但保存时仍由后端校验。
- Markdown 引用是 `skillIds` 的事实来源。

## 7. Agent Profile 编译器

后端新增 `AgentProfileCompilerService`，作为唯一权威解析入口。

```ts
type CompiledAgentProfile = {
  sourceMarkdown: string
  systemPrompt: string
  skillIds: string[]
  toolIds: string[]
  diagnostics: ProfileDiagnostic[]
  contentHash: string
}
```

编译流程：

```text
读取 profileMarkdown
  -> 解析 Skill/Tool 引用
  -> 查询 Skill/Capability Registry
  -> 校验资源状态、类型和权限
  -> 在引用位置展开 Skill 内容
  -> 生成 Tool 使用说明和 Runtime 注册信息
  -> 检查字符数和 token 预算
  -> 生成 systemPrompt、引用索引和内容哈希
```

保存和运行时都必须经过后端编译。

前端预览只用于交互体验，不能成为权威结果。

### 7.1 校验规则

- 引用了不存在的 Skill/Tool：错误。
- 引用了 disabled 资源：错误。
- 引用了 unconfigured Tool：错误。
- Tool 引用不在 Agent `capabilityIds` 中：错误。
- Skill 重复引用：默认错误，避免上下文重复膨胀。
- Profile 编译后超出预算：错误并返回估算信息。
- 无引用的普通 Markdown：保持原样。

### 7.2 Skill 注入一致性

编译器输出必须成为所有 Runtime 的统一 Profile 来源：

- Generic LLM 直接消费编译后的 `agent.systemPrompt`。
- Codex/Claude 的 task sidecar 或 Workdir Brief 必须携带编译后的 Agent Profile。
- 当前通过 `contextPack.systemRules` 追加 Skill 的路径需要收敛，防止重复注入。
- 每次 Runtime invocation 只允许出现一份相同 Skill 内容。

## 8. Runtime 和模型解耦

调整后流程：

```text
创建 Session
  -> 固化 executionTarget
  -> Orchestrator 取得 Agent Definition
  -> AgentProfileCompiler 编译 Profile
  -> 生成 RuntimeAgentProfile
  -> RuntimeService 使用 Session executionTarget
  -> 记录实际模型、Skill、Tool 和 profileHash
```

### 8.1 Runtime 选择优先级

新 Session 使用：

```text
Session 显式选择
  > Project 默认
  > Global 默认
```

新 Session 不再读取 Agent 自身 `runtimeType`。

旧 Session 没有 `executionTarget` 时继续走兼容路径。

### 8.2 模型选择

- Generic LLM 从 Session `executionTarget.modelId` 解析模型连接。
- 未指定模型时，在创建 Session 时解析当前默认模型并固化其 ID。
- Runtime Model 全局切换只影响以后创建的 Session。
- Runtime invocation 必须记录实际使用的模型。

### 8.3 Runtime 审计快照

```ts
type RuntimeInvocationProfileSnapshot = {
  runtimeType: RuntimeType
  modelId?: string
  agentId: string
  profileHash: string
  resolvedSkillIds: string[]
  resolvedSkillRevisions: Record<string, number>
  resolvedToolIds: string[]
}
```

当前阶段 Skill 更新对后续调用生效；每次调用记录实际解析版本和哈希。

工作流阶段再考虑资源版本固定和按节点 pin revision。

## 9. API 设计

### 9.1 Agent

```text
GET    /api/agents
POST   /api/agents
PATCH  /api/agents/:agentId
POST   /api/agents/profile/validate
```

创建和更新请求：

```ts
type AgentUpsertInput = {
  name: string
  role: string
  description?: string
  profileMarkdown: string
  tags?: string[]
  capabilityIds?: string[]
  defaultKnowledgeBaseIds?: string[]
  status?: 'active' | 'disabled'
}
```

`skillIds` 由服务端编译结果生成，客户端不作为权威提交。

### 9.2 Skill

沿用现有接口，补充 `key/status/revision`：

```text
GET    /api/skills
GET    /api/skills/:skillId
POST   /api/skills
PATCH  /api/skills/:skillId
DELETE /api/skills/:skillId
```

### 9.3 Tool/Capability

```text
GET    /api/capabilities
GET    /api/capabilities/:capabilityId
POST   /api/capabilities
PATCH  /api/capabilities/:capabilityId
DELETE /api/capabilities/:capabilityId
POST   /api/capabilities/:capabilityId/check
POST   /api/capabilities/:capabilityId/approve
```

系统内置能力的删除和核心字段修改受保护。

### 9.4 Session

```ts
type CreateSessionRequest = {
  input: string
  agentIds: string[]
  executionTarget?: {
    runtimeType: RuntimeType
    modelId?: string
  }
  // 其他现有字段
}
```

兼容期继续接收 `engineeringRuntimeType`，服务端转换为 `executionTarget`。

## 10. 前端设计

### 10.1 Agent 管理

将 Markdown 编辑能力从模型管理迁移到 Agent 创建/编辑页面。

建议布局：

```text
┌──────────────┬──────────────────────┬──────────────────┐
│ Agent 基础信息 │ Markdown 编辑器       │ Skill/Tool 资源库  │
└──────────────┴──────────────────────┴──────────────────┘
```

功能：

- 创建和编辑使用同一组件。
- Markdown 源码/预览切换。
- Skill/Tool Tab、搜索和分类。
- 多选、查看完整说明。
- 点击插入当前光标位置。
- 拖拽插入指定区域。
- 无效引用显示行列位置和错误状态。
- 引用可以渲染为可识别的 Chip，但源码仍保持占位符。
- 保存前调用后端 Profile 校验。

### 10.2 Skill 管理

在现有 Skill 管理基础上补充：

- 稳定 `key` 展示。
- Markdown 内容预览。
- revision 和状态。
- 被哪些 Agent 引用。
- 删除前影响分析。
- 完整说明查看。

### 10.3 Tool 管理

将当前只读 Tools 页面升级为 Tool/Capability 管理：

- 查看 Tool 说明、schema、风险等级和可用状态。
- 创建和维护自定义 Tool 元数据。
- 显示执行器是否已经配置。
- 系统 Tool 显示受保护字段。
- 查看绑定 Agent 和调用审计。

### 10.4 模型管理

`RuntimeModelManager.vue` 只负责：

- 模型 CRUD。
- 默认模型切换。
- 模型连接和可用状态。

删除：

- Agent 模型绑定。
- Agent Markdown 编辑。
- 按模型展示绑定 Agent。

### 10.5 新建群聊

在现有 Agent 多选基础上增加统一执行目标：

```text
任务描述
工作目录
参与 Agent（一个或多个）
统一 Runtime
统一模型
```

- 选择一个 Agent：单 Agent 对话。
- 选择多个 Agent：多 Agent 群聊。
- 所有参与 Agent 共用相同 `executionTarget`。
- 创建前确认页展示最终 Runtime 和模型。

## 11. 数据迁移与兼容

### 11.1 Agent 模型字段

- 新建 Agent 不再写入 `modelId/runtimeType`。
- 旧 Agent 暂时保留字段，但新 Session 忽略。
- 旧 Session 没有 `executionTarget` 时继续使用旧选择逻辑。
- 兼容窗口结束后再从共享合同和持久化数据中移除旧字段。

### 11.2 Skill

- 为现有 Skill 生成不可变 `key`。
- `revision` 初始化为 `1`。
- `status` 初始化为 `active`。
- Agent 已绑定 Skill 但 Markdown 无引用时，迁移程序自动追加 `${skill:key}`。

### 11.3 Profile

- 保留已有 `profileMarkdown` 原文。
- 只追加缺失的 Skill 引用区域。
- 对可插入 Tool，仅在能确认语义时补充引用，不盲目重写现有 Capability 列表。
- 迁移支持 dry-run、备份和幂等重复执行。

### 11.4 持久化

当前 file/PostgreSQL JSONB collection 后端可以承载新增字段，不要求本期先拆关系表。

后续关系表 migration 必须保持同样的合同语义。

## 12. 安全与风险控制

- Skill 内容属于高信任提示词资源，修改需要审计。
- Markdown 预览必须经过 XSS 清理。
- Tool 占位符不能绕过 Capability 风险策略。
- 高风险 Tool 继续要求用户确认。
- Profile 编译后执行字符数和 token 预算检查。
- Skill/Tool 删除前展示引用它们的 Agent。
- 运行时只注入一次 Skill。
- Session 固化模型，避免运行中漂移。
- 无效模型或不可用 Runtime 明确失败，不允许静默回退。
- Tool 创建不代表执行器已接入，`unconfigured` Tool 不可执行。

## 13. 实施顺序

### Phase 1：合同与迁移骨架

1. 更新共享 Agent、Skill、Capability、Session 合同。
2. 增加 `ExecutionTarget` 和兼容字段说明。
3. 增加 Skill key/revision/status 的数据迁移。
4. 更新 API、Runtime、数据和 UI 状态合同文档。

### Phase 2：Profile 编译器

1. 新增 `AgentProfileCompilerService`。
2. 实现 Skill/Tool 引用扫描、转义、代码块跳过和诊断。
3. 接入 Agent 创建、更新和校验 API。
4. 补充编译长度、token 预算和资源状态检查。

### Phase 3：模型解绑与 Runtime 统一

1. 新 Session 写入 `executionTarget`。
2. 新 Runtime 选择逻辑忽略 Agent `modelId/runtimeType`。
3. Generic LLM 从 Session 读取模型。
4. Codex/Claude task sidecar 注入编译后的 Agent Profile。
5. Runtime invocation 写入 Profile 和资源快照。

### Phase 4：Skill/Tool 管理

1. 扩展 Skill 管理页面。
2. 扩展 Capability Registry 和 Tool CRUD。
3. 增加系统 Tool 保护和自定义 Tool 可用状态。
4. 增加引用影响分析和删除保护。

### Phase 5：Agent 编辑器

1. 将 Markdown 编辑器迁移到 Agent 管理。
2. 实现 Skill/Tool 资源侧栏。
3. 实现多选、点击插入、拖拽插入和详情查看。
4. 实现源码/预览和后端诊断展示。
5. 清理模型管理中的 Agent 编辑职责。

### Phase 6：群聊入口与兼容收敛

1. 新建群聊选择统一 Runtime/模型。
2. 单 Agent 和多 Agent 共用 Session 创建入口。
3. 增加旧 Session 兼容测试。
4. 执行 dry-run/apply 迁移。
5. 更新功能状态、设计和验收文档。

## 14. 验收标准

- Agent 创建和编辑均使用同一 Markdown 编辑器。
- Skill/Tool 可以查看说明、搜索、多选、点击或拖拽插入。
- 无效引用不能保存。
- Agent 新数据不再绑定模型或 Runtime。
- 单 Agent Session 可以正常讨论、执行、复盘和交付。
- 多 Agent Session 共用同一 Runtime/模型。
- Generic LLM 使用 Session 固化模型。
- Codex/Claude 能读取编译后的 Agent Profile。
- Skill 在任意 Runtime 中都不会重复注入。
- Tool 引用不绕过 Capability 权限和高风险确认。
- 旧 Agent 和旧 Session 能在兼容期继续读取和恢复。
- 模型管理页面不再承担 Agent Markdown 和模型绑定职责。

## 15. 验证方案

### 15.1 单元测试

- Markdown 引用解析、转义、代码块和行内代码。
- 重复引用。
- Skill/Tool 不存在、禁用和删除影响。
- Tool 引用与 Capability 权限不一致。
- Profile 长度和 token 预算。
- Skill key/revision/status 迁移。
- Session ExecutionTarget 解析和固化。
- 旧 Session Runtime 兼容。

### 15.2 前端测试

- Agent 创建和编辑复用同一表单。
- Skill/Tool 点击和拖拽插入。
- 多选与 Markdown 双向同步。
- 资源详情和错误诊断。
- 单 Agent/多 Agent Session 创建。
- Runtime/模型联动选择。
- 模型管理不再展示 Agent 绑定。

### 15.3 E2E

- 自定义 Agent + Skill/Tool 引用创建。
- 单 Agent 主链路。
- 多 Agent 讨论主链路。
- Runtime 路由。
- Session 模型固化。
- 高风险 Tool 确认。
- Skill 注入和 Workdir Brief。
- 旧数据迁移与恢复。

建议验证命令：

```bash
npm run typecheck
npm run test
npm run test:harness
npm run test:e2e:runtime-routing
npm run test:e2e:runtime-model-switch
npm run test:e2e:multi-agent-discussion
npm run test:e2e:main-chain
npm run build
```

## 16. 可视化工作流现状与后续计划

线性工作流 v1 已实现 `WorkflowDefinition`、Agent 节点、线性连线、版本、CRUD、拖拽画布、会话选择和逐节点用户确认。当前工作流只表达确定的 Agent 顺序，不等同于通用工作流引擎。

后续目标：

- Scenario 作为面向用户的可复用工作流模板。
- Agent 节点通过 `agentId` 引用 Agent 管理中的统一资产。
- 增加基于 Capability、Skill、Tool、Knowledge、Runtime eligibility 和历史信号的 Agent 能力画像。
- 工作流节点支持 `fixed_agent` 和 `capability_slot`，能力槽位必须输出候选、评分和选择原因。
- 每个 Agent/工作流节点可单独选择 Runtime/模型。
- Agent A 调用 Agent B 通过工作流节点和连线表达。
- 支持条件、并行、汇聚、人工确认和 Tool/MCP 节点。
- Autopilot 通过 `workflowId + version` 触发已发布工作流。
- 支持手工、定时、API 和外部事件触发。
- 可视化编辑器展示运行轨迹、节点状态、输入输出和失败重试。

建议目标模型：

```ts
type WorkflowDefinition = {
  id: string
  version: number
  name: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  status: 'draft' | 'published' | 'archived'
}

type AgentWorkflowNode = {
  id: string
  type: 'agent'
  agentId: string
  executionTarget?: ExecutionTarget
}
```

该阶段再实现：

- 方案 B：每个 Agent/节点独立 Runtime/模型。
- Agent-to-Agent 委派深度和循环检测。
- Scenario/Workflow 版本固定。
- Autopilot 与发布工作流的正式绑定。

## 17. 当前工作流 v1 非目标

- 当前只创建 Workflow 定义 API 和线性编辑页面，不创建 Scenario 表、模板市场或通用节点注册表。
- 本方案不修改 Autopilot 现有调度语义。
- 本方案不在 Markdown 中支持 `${agent:key}`。
- 本方案不实现通用工作流引擎。
- 本方案不把 Harness Engineering 变成可编辑业务配置。
- 本方案不因为创建 Tool 定义而自动获得真实执行能力。

## 18. 相关文档

- `docs/product/agent-cluster-prd-v1.md`
- `docs/design/agent-cluster-system-design-v1.md`
- `docs/design/agent-harness-profile-architecture-v1.md`
- `docs/contracts/api-contract-v0.1.md`
- `docs/contracts/data-contract-v0.1.md`
- `docs/contracts/runtime-contract-v0.1.md`
- `docs/contracts/ui-state-contract-v0.1.md`
- `docs/analysis/feature-inventory-and-status-v1.md`
- `docs/ai-agent-context/pluggable-engineering-runtime-memory.md`
- `docs/harness-engineering/00-boundary-and-principles.md`
