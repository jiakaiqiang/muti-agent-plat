# 02 Context Protocol 上下文协议

> 最后修改时间：2026-06-12 11:20:34 +08:00
> 修改人：Claude Code
> 修改的 Agent：Claude Code

## 目的

规定每个阶段的 Agent 应该看到什么、不应该看到什么。

上下文不是越多越好。Harness Engineering 的核心职责之一，是让 Agent 在正确阶段获得正确上下文。

## 参与角色

- Requirement Agent
- Architect Agent
- Coordinator Agent
- Implementation Agent
- Verification Agent
- Review Agent
- Delivery Agent

## 上下文条目模型

每条进入阶段的上下文按两个维度标注：

来源（source）：

- user：用户输入与用户确认。
- project：项目事实，包括代码、合同、文档、测试。
- tool：工具观察结果，包括命令输出、测试结果、检索结果。
- memory：交付记忆与历史产物。
- inference：Agent 推断、假设、未确认想法。

状态（state）：

- active：可作为当前决策依据。
- stale：已过期，不得作为决策依据。
- conflict：与其他条目冲突，处理前不得使用。

`inference` 来源的条目默认不可作为验收依据，除非被 `user` 确认或 `tool` 验证。

## 上下文生命周期

```text
collect -> filter -> bind_to_stage -> use -> verify -> retain / drop / stale
```

- collect：只从允许的来源收集。
- filter：裁剪到当前阶段最小必要集合。
- bind_to_stage：与阶段产物绑定，可追溯。
- verify：进入下一阶段前核对状态标注。
- retain / drop / stale：阶段结束时决定保留、丢弃或标记过期。

## 上下文污染处理

| 污染类型 | 处理 |
| --- | --- |
| 冲突（conflict） | 当前阶段重建 Context，必要时升级人工确认 |
| 过期（stale） | 标记 stale，不作为决策依据 |
| 范围诱导 | 回到 Requirement 或 Design 确认 |
| 噪音过载 | 裁剪到当前阶段最小必要上下文 |

## 阶段入口检查

进入任一阶段前回答三问：

1. 本阶段的决策依据来自哪些来源（source）？
2. 是否存在未处理的 conflict 或 stale 条目？
3. 是否已裁剪与本阶段无关的上下文？

## 阶段上下文

### Requirement

应该看到：

- 用户原始需求
- 历史偏好
- 产品目标

不应该看到：

- 无关实现细节
- 未确认的技术方案

### Design

应该看到：

- Intent Contract
- 项目架构说明
- 相关契约
- 相关代码路径
- 已知风险

不应该看到：

- 无关模块全文
- 与本需求无关的历史会话噪音

### Planning

应该看到：

- Intent Contract
- Design Plan
- Agent 角色边界
- 工具治理规则

### Implementation

应该看到：

- Task Plan
- Design Plan
- 允许修改范围
- 工具权限
- 验收标准

不应该看到：

- 与任务无关的上下文
- 可诱导扩大范围的未确认想法

### Verification

应该看到：

- Intent Contract
- Design Plan
- Implementation Summary
- 已完成产物
- 需要验证的验收标准

### Review

应该看到：

- 全过程阶段产物
- 交接记录
- 返工记录
- 人工确认记录

### Delivery

应该看到：

- 全部阶段产物
- Review 结论
- 剩余风险
- 需要沉淀的经验

## 退出条件

- 当前阶段上下文足以完成该阶段任务。
- 上下文没有明显越界。
- 上下文条目已按来源（source）和状态（state）标注，inference 条目未被当作事实使用。

## 返工条件

- Agent 因上下文不足无法推进。
- Agent 拿到无关上下文导致范围扩大。
- 评审发现阶段产物引用了未提供或未确认的信息。

## 返工信号入口

本节定义当反馈循环（`../feedback-loop/07-feedback-loop.md`）触发返工时，上下文协议如何接收信号并重组上下文。对应闭环模型中的边 ③（Feedback → Context）。

### 返工信号字段

来自 Feedback 的返工信号必须携带以下字段：

- `回退目标阶段`：Requirement / Design / Planning / Implementation 之一
- `失败分类`：来自 `../feedback-loop/07-feedback-loop.md` 的分类
- `证据`：评审或验证发现的具体问题
- `上下文缺口`：缺失或越界的上下文项

### 重组规则

收到返工信号后，按回退目标阶段重组上下文，**不复用上一次失败时的同一份上下文**：

- 回退到 Requirement：补充用户原始需求中遗漏的目标、约束、待确认问题；移除已被否定的假设。
- 回退到 Design：补充影响范围、相关契约、被忽略的代码路径；标注本次设计需重新审视的取舍。
- 回退到 Planning：补充任务依赖、允许范围说明；移除已被验证不可行的任务定义。
- 回退到 Implementation：补充缺失的允许范围、工具权限、验收标准；标注上一次实现中越界的部分。

### 重组后的退出条件

- 上下文缺口字段中列出的项已被补齐。
- 上一次失败的证据可以在新上下文中被定位、判断或反驳。
- 重组动作被记录，可被后续 Governance 检测（对应边 ⑥）。

## 工作区覆盖盲区与 CONTEXT_INSUFFICIENT 协议（Context Engineering Remediation v1）

实现细则参考 `prompt-context/runtime-context-contract.md`，治理方案 `docs/roadmap/context-engineering-remediation-v1.md`。

### 工作区扫描覆盖（`workspaceManifest.coverage`）

扫描端（服务端与浏览器端）必须在 finalize 阶段把 `skipped[]` 聚合成 `WorkspaceManifestCoverage = { totalEntriesSeen, scannedEntries, readableFiles, skippedByReason }`，并随 `WorkspaceSnapshot` / `ContextPack.workspaceManifest` 透传给运行时。

- `WorkspaceSkippedReason` 同一份枚举：`ignored_directory | binary | too_large | sensitive | limit_exceeded | read_error`。
- 当扫描盲区存在（`scannedEntries < totalEntriesSeen` 或 `skippedByReason` 有计数）时，上下文协议自动在 `systemRules` 追加 CONTEXT_INSUFFICIENT 提示，要求运行时通过 `requestedPaths` 显式拉取缺失内容，不允许凭空推断。

### 运行时回填重试预算

- 单会话允许的连续 CONTEXT_INSUFFICIENT 重试次数受 `AGENT_CLUSTER_CONTEXT_INSUFFICIENT_MAX_RETRIES` 控制，默认 3。
- `supplementalContextRequests` 入库前必须 dedupe：相同 `(refKind+ref/label)`、相同 `requestedPaths`、相同 `requestedCommands` 不重复落库，整轮全是重复的请求直接拒绝重试，并在 `session.events` 落 `agent_message{phase:'context_supplement', rejectionReason:'duplicate_request'}`。
- runtime 收到 `requestedContext` 后只能补充新条目；不允许把已经被 supply 过的 ref/path/command 重新打包。

### Token preflight：`navigation_only` 终极兜底

裁剪阶段链：`initial → focused → compact → minimal → ultra-minimal → emergency → navigation_only`。

- 上下文协议要求 emergency 仍越 `budget.maxInputTokens` 时必须降级到 `navigation_only`，禁止直接抛 `TOKEN_BUDGET_EXCEEDED`。
- `navigation_only` 产出：`workspaceManifest` 仅保 `rootName + entrypoints + detectedStack`，`workspaceFocus` 仅保 `relevantFiles + possibleEntryPoints + validationCommands`，`selectedEvidenceContents / projectMap / relevantEvents / relevantMemories / ragSnippets / artifacts` 全清空，`taskContext / currentTask / taskBrief / agentProfile / summaryMemory` 压扁到 id/title/status 级别。
- `systemRules` 末尾必须追加 `contextDegraded=true: ...`，告知 runtime 必须通过 CONTEXT_INSUFFICIENT.requestedPaths 主动取回需要的文件，禁止凭空推断。
- diagnostics 新增 `stagesTried[]` / `finalStage` / `droppedSections[]`，供 Governance 与 debug 接口追踪降级路径。

### selectedEvidenceContents 智能截断 hint

`workspaceEvidenceContent` 使用 `truncateContentForEvidence(path, content, budget, { query? })` 截断文件内容，并把 `truncatedHint` 透传到 `selectedEvidenceContents[].truncatedHint`。

- 策略：`slice | ts-symbol-window | md-section-window`。
- TS/JS/Vue 在 query 命中时保留 imports + 命中符号体；Markdown 按 H2 章节装填 + 命中优先；其它走 slice。
- Hint 字段：`{ strategy, originalBytes, keptBytes, droppedRanges?, keptSections?, droppedSections? }`。debug 接口必须暴露该字段以便人工或自动审计裁剪是否丢了关键信息。
