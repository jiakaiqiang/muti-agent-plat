# Context Router 目标设计 v1

## 1. 目标

本文档定义如何将 Codex 式“入口规则、项目地图、按需读取、最小证据、摘要续跑”的上下文治理思想应用到 Agent Cluster。

目标不是让平台一次性读取整个项目，也不是复制 Codex 或 Claude Code 的终端体验，而是在当前聊天室式多 Agent 协作平台中建立一套可解释、可裁剪、可追溯的上下文编排能力。

最终形态：

```text
用户需求
  -> 意图识别
  -> 工作区/项目地图
  -> 上下文路由
  -> 最小证据选择
  -> Context Pack
  -> Agent 讨论、执行、验证
  -> 摘要记忆与续跑
```

## 2. 非目标

- 不把整个工作区原文一次性发送给 Runtime。
- 不绕过用户确认读取敏感文件。
- 不把 Harness Engineering 做成业务运行时功能。
- 不让 Runtime 直接越过 Capability Module 执行文件写入、命令执行或外部副作用。
- 不用固定产物文件替代真实受影响文件的分析和修改。
- 不要求所有项目都必须手写完整项目地图；系统应支持静态规则和动态扫描结合。

## 3. 当前基础

当前项目已经具备部分上下文治理基础：

- `WorkspaceSnapshot`：前端扫描工作区并上传有边界的文件快照。
- `workspaceFocus`：记录相关文件、影响文件、测试文件、配置文件、入口和验证命令。
- `ContextPack`：Runtime 的统一输入，不直接传完整事件流。
- `TaskContext`：包含任务领域、意图、任务地图、阶段计划、验证规则和职责分工。
- `evidenceSelection`：记录最小证据选择结果和 omitted evidence。
- `summaryMemory`：跨阶段摘要记忆。
- `continuationState`：任务切换、续跑和恢复状态。
- `RuntimeBudget`：上下文和调用预算。
- Debug API 和前端调试视图：可查看 context packs、RAG、runtime invocations 和 token usage。

因此本设计应优先补齐产品化闭环，而不是重建一套平行上下文系统。

## 4. 目标能力

### 4.1 入口规则层

入口规则层负责收集当前任务必须遵守的最高优先级规则。

典型来源：

- 用户会话输入和显式约束。
- 工作区内的 `AGENTS.md`。
- 工作区内的 `.claude/CLAUDE.md`。
- 项目 `README.md`、`package.json` 和框架配置。
- 项目已有文档中的 AI 工作规则。
- Agent 自身角色、能力和 Runtime 约束。

规则：

- 入口规则应先被摘要和结构化，再进入 Context Pack。
- 敏感信息和无关长文档不应进入 Runtime。
- 冲突规则必须显式记录，例如用户要求与项目规则冲突。

### 4.2 项目地图层

项目地图层负责回答“这个项目有哪些区域，每类需求应该优先看哪里”。

目标结构：

```ts
type ProjectMap = {
  source: 'static' | 'generated' | 'merged';
  modules: Array<{
    name: string;
    path: string;
    responsibility: string;
    entrypoints: string[];
    contracts: string[];
    tests: string[];
    commonTasks: string[];
  }>;
  validationCommands: string[];
  riskBoundaries: string[];
  memoryLocations: string[];
};
```

来源：

- 静态项目地图：`AGENTS.md`、`.claude/CLAUDE.md`、`docs/ai-agent-context/project-map.md`、项目 README。
- 动态扫描地图：目录结构、package scripts、配置文件、测试文件、合同文件和入口文件。
- 历史记忆：经过确认的项目约定、风险和常用验证路径。

规则：

- 静态地图优先表达项目意图。
- 动态地图用于补齐静态地图缺失的真实文件结构。
- 合并后必须保留来源引用，便于 debug 和审计。

### 4.3 上下文路由层

上下文路由层负责根据用户需求、当前阶段和项目地图选择应该读取的区域。

输入：

```text
用户消息
会话状态
当前 Agent 和阶段
WorkspaceSnapshot
ProjectMap
RAG / Memory / Artifact / Event 摘要
RuntimeBudget
```

输出：

```text
TaskContext
workspaceFocus
候选 evidence refs
读取计划 read/do/validate
```

示例：

```text
用户需求：修复 Runtime 模型切换问题

路由结果：
- domain: coding
- intent: troubleshooting
- modules: runtimes, web runtime model store
- key materials:
  - runtime contract
  - runtime model config service
  - frontend runtime model store
- validation:
  - npm run test:e2e:runtime-model-switch
  - npm run typecheck
```

规则：

- 路由结果必须解释为什么选择这些模块和文件。
- 如果 workspace snapshot 不足，Runtime 应请求更多上下文，而不是臆造文件内容。
- 查询、讨论、实现、验证等不同阶段应使用不同的最小上下文。

### 4.4 证据选择层

证据选择层负责从候选上下文中裁剪出当前阶段可用的最小证据集。

优先级：

1. 用户明确提到的文件、错误、命令或约束。
2. 项目入口规则。
3. 与需求直接相关的模块入口。
4. 合同、共享类型和 API 边界。
5. 最近错误日志、测试结果或复盘证据。
6. 相关测试文件和验证命令。
7. RAG、Memory、历史决策和 artifact。

目标结构沿用 `TaskContext.evidenceSelection`：

```ts
type EvidenceSelection = {
  phase: AgentRunPhase;
  strategy: 'coding_minimal' | 'non_coding_minimal' | 'mixed_minimal';
  query: string;
  maxEvidenceRefs: number;
  selectedRefs: TaskEvidenceRef[];
  omittedRefs: TaskEvidenceRef[];
  rules: string[];
};
```

规则：

- Runtime 只能把 `selectedRefs` 视为已注入证据。
- `omittedRefs` 只表示系统知道它们存在，不表示 Runtime 已看到内容。
- 大文件默认摘要化或切片化，不直接全文注入。
- 超预算时优先保留入口规则、合同、用户明确文件、错误日志和测试证据。

### 4.5 Context Pack 构建层

Context Pack 构建层负责把路由结果、证据选择、摘要记忆和 Runtime 约束组装成统一输入。

规则：

- Runtime 不接收完整群聊历史。
- Runtime 不接收完整工作区。
- `taskBrief` 优先级高于长期 Memory 和 RAG。
- `taskContext.evidenceRefs` 必须等于已选择证据。
- `workspaceFocus` 用于解释文件级判断，不等于写权限。
- Capability、权限、预算和风险约束必须显式进入 `constraints`。

### 4.6 摘要记忆与续跑层

摘要记忆层负责让长任务不依赖完整历史。

每个关键阶段结束后沉淀：

```ts
type SummaryMemory = {
  goal: string;
  currentState: string;
  confirmedFacts: string[];
  completed: string[];
  decisions: string[];
  openQuestions: string[];
  risks: string[];
  nextSteps: string[];
  checkpointRefs?: string[];
};
```

阶段规则：

- 讨论结束：沉淀需求理解、范围、非目标、风险和未决问题。
- 任务确认：沉淀用户确认的任务合同。
- 执行结束：沉淀实际修改、产物、diff 和失败/成功状态。
- 验证结束：沉淀命令、结果、证据和剩余风险。
- 返工开始：只携带失败原因、修正方向和必要证据。
- 最终交付：沉淀交付结果、未完成项和可复用知识。

## 5. 建议服务划分

### 5.1 ProjectMapService

职责：

- 从静态文档和工作区快照生成项目地图。
- 合并静态规则、动态扫描和历史记忆。
- 输出模块、入口、合同、测试、验证命令和风险边界。

典型输入：

- `WorkspaceSnapshot`
- `AGENTS.md`
- `.claude/CLAUDE.md`
- `README.md`
- `package.json`
- `docs/ai-agent-context/project-map.md`

典型输出：

- `ProjectMap`
- `ProjectMapSummary`
- 可追溯来源 refs

### 5.2 ContextRouterService

职责：

- 根据用户需求、阶段、Agent 角色和项目地图生成上下文路由。
- 输出 `TaskContext.taskMap`、`stagePlan` 和候选 evidence。
- 解释选择原因。

典型输出：

- `domain`
- `intent`
- `requiresCodeChanges`
- `workspaceFocus`
- `candidateEvidenceRefs`
- `validationRules`

### 5.3 EvidenceSelector

职责：

- 对候选 evidence 评分、去重、裁剪和预算估算。
- 生成 `selectedRefs` 和 `omittedRefs`。
- 标记选择规则和预算原因。

典型策略：

- `coding_minimal`
- `non_coding_minimal`
- `mixed_minimal`

### 5.4 ContextPackBuilder

职责：

- 将系统规则、任务地图、最小证据、摘要记忆、续跑状态和 Runtime 约束组装为 `ContextPack`。
- 保证 Runtime 输入稳定、可验证、可调试。

### 5.5 ContextDebugPresenter

职责：

- 为 debug API 和前端调试页提供人类可读解释。
- 展示 selected / omitted / compacted evidence。
- 展示每个阶段的 read / do / validate 计划。
- 展示 token 预算和裁剪原因。

## 6. 端到端流程

### 6.1 新会话

```text
用户选择工作区
  -> 前端扫描 WorkspaceSnapshot
  -> 后端创建 session
  -> ProjectMapService 生成或合并 ProjectMap
  -> ContextRouterService 识别需求落点
  -> EvidenceSelector 选择 brief 阶段证据
  -> ContextPackBuilder 生成 brief_generation ContextPack
  -> Coordinator 生成任务合同
```

### 6.2 用户确认后执行

```text
用户确认 TaskBrief
  -> 按任务生成 execution phase route
  -> EvidenceSelector 选择任务执行证据
  -> Runtime 执行
  -> 产出 artifact、fileChanges、usage 和 runtime events
  -> SummaryMemory checkpoint
  -> Review Agent 使用独立验证 ContextPack
```

### 6.3 上下文不足

```text
Runtime 判断证据不足
  -> 返回 needs_more_context
  -> ContextRouterService 生成补充读取请求
  -> EvidenceSelector 重新裁剪
  -> 当前阶段续跑
```

该流程避免 Runtime 在未知文件、未知 API 或未知错误原因上编造结论。

## 7. 分阶段实现计划

### Phase 1：显性化上下文路由

目标：

- 将当前散落在 Orchestrator 中的上下文选择逻辑抽出为 `ContextRouterService`。
- 保持现有合同不破坏。
- Debug 页面能说明每次 Context Pack 为什么选这些上下文。

建议修改区域：

- `apps/server/src/modules/orchestrator/`
- `apps/server/src/modules/debug/`
- `packages/shared/src/contracts.ts`
- `apps/web/src/components/DebugRuntimeView.vue`

验收：

- `ContextPack.taskContext.stagePlan` 始终包含 read / do / validate。
- `evidenceSelection.selectedRefs` 和 `taskContext.evidenceRefs` 一致。
- Debug 视图可见 selected / omitted evidence。

建议验证：

```bash
npm run test:e2e:unified-task-context
npm run test:e2e:token-budget
npm run typecheck
```

### Phase 2：项目地图生成

目标：

- 增加 `ProjectMapService`。
- 支持从工作区入口规则、README、package scripts、目录结构和现有项目地图生成结构化 Project Map。
- 让 `workspaceFocus` 从 Project Map 中派生验证命令和关键资料。

建议修改区域：

- `apps/server/src/common/workspace-scanner.ts`
- `apps/server/src/modules/orchestrator/`
- `packages/shared/src/contracts.ts`
- `docs/contracts/runtime-contract-v0.1.md`

验收：

- 编程任务能生成 `project_map`。
- 非编程任务能生成 `domain_map`。
- Project Map items 包含模块、边界、入口、关键资料和验证路径。

建议验证：

```bash
npm run test:e2e:server-local-project-analysis
npm run test:e2e:workspace-snapshot-payload
npm run typecheck
```

### Phase 3：按需补充上下文

目标：

- Runtime 可显式返回上下文不足信号。
- Orchestrator 可根据请求补充指定文件、日志、RAG 或测试证据。
- 当前阶段可在补充 Context Pack 后续跑。

建议修改区域：

- `packages/shared/src/contracts.ts`
- `apps/server/src/modules/runtimes/`
- `apps/server/src/modules/orchestrator/`
- `apps/server/src/modules/events/`

验收：

- Runtime 不足时不臆造。
- 用户可在聊天室看到“请求更多上下文”的原因。
- 补充上下文仍受 token budget 和安全过滤约束。

建议验证：

```bash
npm run test:e2e:unified-task-context
npm run test:e2e:rework-loop
npm run typecheck
```

### Phase 4：预算与压缩增强

目标：

- 对每个 evidence 做 token 估算。
- 支持大文件摘要、符号级索引和内容切片。
- 超预算时输出可解释的裁剪结果。

建议修改区域：

- `apps/server/src/common/token.ts`
- `apps/server/src/modules/orchestrator/`
- `apps/server/src/modules/debug/`
- `apps/web/src/components/DebugRuntimeView.vue`

验收：

- 超预算不会直接导致 Runtime 拿到过大输入。
- omitted evidence 保留来源和裁剪原因。
- debug 视图可见预算分布。

建议验证：

```bash
npm run test:e2e:token-budget
npm run test:e2e:workspace-snapshot-payload
npm run typecheck
```

### Phase 5：真实 Coding Runtime 接入

目标：

- Codex / Claude Code Runtime 只接收裁剪后的 Context Pack。
- 文件修改、命令执行和外部工具调用通过 Capability Module 审计。
- Runtime 输出映射为 artifact、diff、test report 和 runtime events。

建议修改区域：

- `apps/server/src/modules/runtimes/codex-runtime-adapter.service.ts`
- `apps/server/src/modules/runtimes/claude-code-runtime-adapter.service.ts`
- `apps/server/src/modules/capabilities/`
- `apps/server/src/modules/artifacts/`
- `apps/web/src/components/ChatTimeline.vue`

验收：

- 未授权写入或命令执行会被阻断。
- 用户能看到 diff、验证结果和最终交付。
- Runtime 失败不会静默回退 mock。

建议验证：

```bash
npm run test:e2e:runtime-routing
npm run test:e2e:codex-runtime-stub
npm run test:e2e:claude-code-runtime-stub
npm run test:e2e:artifact-file-changes
npm run typecheck
```

## 8. 质量门

每个阶段至少满足：

- Context Pack 可追溯：每个 injected evidence 都能找到来源。
- Context Pack 可裁剪：超预算时能解释保留和省略原因。
- Runtime 不臆造：缺上下文时请求补充。
- 用户可见：关键分析、风险、diff、验证和交付必须进入事件流或 artifact。
- 权限明确：工作区上下文不等于写权限，高风险能力必须经过 Capability Module。

## 9. 成功标准

当该设计落地后，Agent Cluster 应具备以下能力：

- 用户提出需求后，系统能说明“我为什么看这些文件”。
- 多 Agent 在不同阶段接收不同的最小 Context Pack。
- 大项目不会因为文件多而超出上下文。
- 长任务不会因为历史过长而漂移。
- Debug 视图能追踪上下文选择、预算裁剪和续跑状态。
- 真实 Codex / Claude Runtime 接入时，可以复用同一套上下文治理和审计机制。

## 10. 推荐优先级

优先做 `ContextRouterService` 抽象。

原因：

- 当前项目已经有 `TaskContext`、`workspaceFocus`、`evidenceSelection` 和 token budget。
- 抽出上下文路由能减少 Orchestrator 膨胀。
- Debug 可解释性会立刻提升。
- 后续 Project Map、按需补充和真实 Coding Runtime 都依赖这层稳定边界。
