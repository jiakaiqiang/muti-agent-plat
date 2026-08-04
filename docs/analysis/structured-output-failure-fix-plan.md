# 结构化输出失败修复方案（Claude Code + Opus 4.8）

**日期**：2026-08-04  
**环境**：Claude Code Runtime + Opus 4.8  
**问题**：系统架构师在 brief_generation 阶段 5 次尝试后仍无法生成有效的 task_brief

---

## 确认的环境信息

- **Runtime**：Claude Code（不是 Generic LLM）
- **模型**：Opus 4.8（顶级模型，能力足够）
- **失败点**：`--json-schema` 验证失败
- **重试次数**：5 次（Claude Code CLI 内部逻辑）

---

## 根本原因（已定位）

### 发现的关键问题

在 `apps/server/src/modules/runtimes/claude-code-runtime-adapter.service.ts:484-486` 中，针对 `task_brief` 的 Prompt 指令**过于简单**：

```typescript
input.expectedOutput.kind === 'task_brief'
  ? 'For every suggestedTasks item, routingMode must be exactly "coordinator_controlled", "agent_suggested", "agent_delegated", or null. Copy the underscore-separated spelling exactly.'
  : ''
```

这个指令只强调了 `routingMode` 字段的拼写，但没有：
1. 明确说明 task_brief 的完整结构要求
2. 给出如何从架构分析转换为任务简报的指导
3. 强调所有必填字段的重要性

### 为什么 Opus 4.8 也会失败？

即使是强大的模型，也需要清晰的指令。当前的问题是：

1. **Agent 角色冲突**
   - 系统架构师的 `agent.role`：`从架构视角分析当前项目结构与主链路，并给出架构方面的想法和建议`
   - 但要求输出 `task_brief`：需要任务拆解、派发计划

2. **Prompt 中缺少桥接**
   - 没有告诉模型"如何将架构分析转换为任务简报"
   - 没有说明 `suggestedTasks` 应该是什么样的任务

3. **Schema 约束严格**
   - `routingMode` 必须是特定枚举值
   - `requiresUserConfirmation` 必须是 boolean
   - 所有 NonEmptyString 必须非空
   - Opus 4.8 可能生成了合理的架构分析，但不符合 Schema 约束

---

## 修复方案（P0 - 立即实施）

### 方案：增强 Claude Code Prompt 指令

**位置**：`apps/server/src/modules/runtimes/claude-code-runtime-adapter.service.ts:484-486`

**当前代码**：
```typescript
input.expectedOutput.kind === 'task_brief'
  ? 'For every suggestedTasks item, routingMode must be exactly "coordinator_controlled", "agent_suggested", "agent_delegated", or null. Copy the underscore-separated spelling exactly.'
  : ''
```

**修复后的代码**：
```typescript
input.expectedOutput.kind === 'task_brief'
  ? [
      'CRITICAL: You MUST return a complete task_brief JSON object with ALL required fields.',
      '',
      'Required top-level fields:',
      '  - schemaVersion: "1.0" (literal string)',
      '  - kind: "task_brief" (literal string)',
      '  - goal: non-empty string describing the overall objective',
      '  - scope: array of strings (what is included)',
      '  - outOfScope: array of strings (what is excluded)',
      '  - constraints: array of strings (technical/resource constraints)',
      '  - acceptanceCriteria: array of strings (how to verify success)',
      '  - risks: array of strings (potential issues)',
      '  - openQuestions: array of strings (unresolved items)',
      '  - suggestedTasks: array of task objects (at least 1 required)',
      '',
      'Each suggestedTasks item MUST have:',
      '  - title: non-empty string',
      '  - description: non-empty string',
      '  - suggestedAgentKey: string or null (e.g., "architect", "frontend", "backend")',
      '  - routingMode: EXACTLY one of "coordinator_controlled", "agent_suggested", "agent_delegated", or null (copy the underscore spelling)',
      '  - assignmentReason: string or null',
      '  - contextRequirements: array of strings',
      '  - verificationPlan: array of strings',
      '  - riskNotes: array of strings',
      '  - requiresUserConfirmation: boolean (true or false)',
      '  - dependsOnTaskTitles: array of strings',
      '  - acceptanceCriteria: array of strings',
      '',
      'When acting as an architect analyzing project architecture:',
      '  1. Set goal to describe the architecture understanding objective',
      '  2. In scope: list key directories/modules/components to analyze',
      '  3. In outOfScope: list what is NOT part of this analysis',
      '  4. Create ONE architect task in suggestedTasks with:',
      '     - title: "分析项目架构与主链路"',
      '     - description: detailed analysis plan (what to analyze, how to analyze, expected output)',
      '     - suggestedAgentKey: "architect"',
      '     - routingMode: "coordinator_controlled"',
      '     - requiresUserConfirmation: false',
      '     - acceptanceCriteria: ["架构图已生成", "主执行链路已梳理", "模块边界已说明", "架构风险已识别"]',
      '',
      'DO NOT output architecture analysis directly.',
      'DO NOT add fields not in the schema.',
      'DO NOT use different spellings for routingMode (no camelCase, no hyphens).',
      'DO NOT omit required fields.',
      'DO NOT return empty strings for non-empty fields.'
    ].join('\n')
  : ''
```

---

## 实施步骤

### 1. 备份当前代码
```bash
git diff apps/server/src/modules/runtimes/claude-code-runtime-adapter.service.ts
```

### 2. 应用修复
修改 `claude-code-runtime-adapter.service.ts:484-486`

### 3. 验证类型检查
```bash
npm run typecheck
```

### 4. 运行测试
```bash
npm run test -- claude-code-runtime-adapter.service.spec.ts
```

### 5. 手动测试
- 创建一个架构分析任务
- 观察系统架构师是否能成功生成 task_brief
- 检查生成的 JSON 是否符合 Schema

---

## 预期效果

修复后，Claude Code 会收到更明确的指令：
1. ✅ 知道 task_brief 的完整结构
2. ✅ 知道如何从架构分析转换为任务简报
3. ✅ 知道每个字段的类型和约束
4. ✅ 知道 `routingMode` 的精确拼写
5. ✅ 知道架构师场景下应该生成什么样的任务

---

## 备选方案（如果修复后仍失败）

### 方案 B：简化 task_brief 的默认值

在 `packages/shared/src/runtime-contracts/output-contracts.ts:260-285` 中，示例已经提供了最小结构：

```typescript
task_brief: {
  schemaVersion: '1.0',
  kind: 'task_brief',
  goal: 'State the user goal.',
  scope: [],
  outOfScope: [],
  constraints: [],
  acceptanceCriteria: [],
  risks: [],
  openQuestions: [],
  suggestedTasks: [
    {
      title: 'Implement the requested change.',
      description: 'Apply the scoped change and verify the acceptance criteria.',
      suggestedAgentKey: null,
      routingMode: 'coordinator_controlled',
      assignmentReason: 'The coordinator assigns the task to the best available agent.',
      contextRequirements: [],
      verificationPlan: [],
      riskNotes: [],
      requiresUserConfirmation: false,
      dependsOnTaskTitles: [],
      acceptanceCriteria: []
    }
  ]
}
```

可以在 Prompt 中直接提供这个模板，让模型填充。

### 方案 C：增加调试日志

在 `claude-code-runtime-adapter.service.ts` 中增加日志，记录：
1. 模型实际输出的内容（在 Schema 验证失败前）
2. 验证失败的具体错误信息
3. 每次重试的变化

位置：`parseClaudeBufferedOutputWithRuntimeError()` 函数前后

---

## 验证清单

修复后需要验证：
- [ ] 系统架构师能成功生成 task_brief
- [ ] task_brief 包含所有必填字段
- [ ] suggestedTasks 至少有 1 个任务
- [ ] routingMode 拼写正确
- [ ] 生成时间 < 120 秒
- [ ] 不影响其他 Agent 的 brief_generation

---

## 风险评估

**修复风险**：低
- 只修改了 Prompt 文本
- 不改变 Schema 定义
- 不改变编排逻辑
- 向后兼容

**回滚方案**：
```bash
git checkout apps/server/src/modules/runtimes/claude-code-runtime-adapter.service.ts
npm run build
```

---

## 后续优化（P1）

如果问题根本原因是"架构师不应该输出 task_brief"，可以考虑：

1. **新增 `architecture_analysis` RuntimeOutput kind**
   - 专门为架构师设计
   - 字段更符合架构分析的输出
   
2. **调整编排逻辑**
   - 架构师输出 `architecture_analysis`
   - Coordinator 根据 `architecture_analysis` 生成 `task_brief`

3. **增加 Agent 能力验证**
   - 在分配任务前，检查 Agent 的 `capabilityIds` 是否包含 `cap-brief`
   - 如果不包含，自动改派或拒绝

---

## 相关文件

- `apps/server/src/modules/runtimes/claude-code-runtime-adapter.service.ts:484-486` - 修复位置
- `packages/shared/src/runtime-contracts/output-contracts.ts:84-95` - task_brief Schema
- `packages/shared/src/default-agent-presets.ts:67-92` - 系统架构师定义
- `apps/server/src/modules/orchestrator/orchestrator.service.ts:322-332` - brief_generation 调用

---

## 联系人

如有疑问，请参考：
- 诊断报告：`docs/analysis/structured-output-failure-diagnosis-2026-08.md`
- Harness Engineering：`docs/harness-engineering/`
