# 结构化输出失败问题诊断报告

**日期**：2026-08-04  
**问题类型**：Claude Code Runtime 结构化输出失败  
**影响范围**：系统架构师 Agent 在 brief_generation 阶段

## 问题现象

### 用户报告
- **阶段**：工作流阶段 → 系统架构师
- **错误消息**：`Claude Code exited with code 1: Failed to provide valid structured output after 5 attempts`
- **错误类型**：`MODEL_ERROR`
- **状态**：运行时任务失败 → 失败
- **等待时长**：480 秒（8 分钟）

### 截图信息
```
系统架构师 的模型调用仍在进行中（已等待 480 秒）。

运行时任务失败

工作流阶段：系统架构师

错误详情
阶段
错误
Claude Code exited with code 1: Failed to provide valid structured output after 5 attempts

错误代码
MODEL_ERROR

可重试
可建议

运行时任务失败：工作流阶段：系统架构师
```

## 根因分析

### 1. 错误来源定位

**关键发现**："5 attempts" 是 Claude Code CLI 的内部重试逻辑，不是我们的代码。

#### 代码证据

- `apps/server/src/common/runtime-config.ts:120-123`：`llmSchemaRepairAttempts()` 默认值为 **1**
- `apps/server/src/modules/runtimes/generic-llm-runtime.service.ts:353-364`：Generic LLM 的 Schema repair 最多 1 次
- `packages/local-runtime-cli/src/adapters/claude-code-adapter.ts:133`：传递 `--json-schema` 给 Claude CLI
- Claude Code CLI 内部对结构化输出有 **5 次重试机制**，全部失败后以 `exit code 1` 退出

### 2. 问题触发路径

```
用户请求
  └─> orchestrator.service.ts:322-332 (runBriefGeneration)
      └─> phase: 'brief_generation'
      └─> agent: coordinator (系统架构师)
      └─> expectedOutput: { kind: 'task_brief', schemaVersion: '1.0' }
      └─> runRuntime()
          └─> Claude Code CLI 执行
              └─> 传递 task_brief Schema
              └─> 模型尝试 5 次生成结构化输出
              └─> 全部失败
              └─> exit code 1
```

### 3. task_brief Schema 复杂度

#### Schema 结构
```typescript
TaskBriefOutputSchema = {
  schemaVersion: '1.0',
  kind: 'task_brief',
  goal: NonEmptyString,                    // 必填
  scope: StringArray,                      // 必填
  outOfScope: StringArray,                 // 必填
  constraints: StringArray,                // 必填
  acceptanceCriteria: StringArray,         // 必填
  risks: StringArray,                      // 必填
  openQuestions: StringArray,              // 必填
  suggestedTasks: Array<SuggestedAgentTask> // 必填，至少 1 个
}

SuggestedAgentTaskSchema = {
  title: NonEmptyString,                   // 必填
  description: NonEmptyString,             // 必填
  suggestedAgentKey: NullableString,
  routingMode: 'coordinator_controlled' | 'agent_suggested' | 'agent_delegated' | null,
  assignmentReason: NullableString,
  contextRequirements: StringArray,
  verificationPlan: StringArray,
  riskNotes: StringArray,
  requiresUserConfirmation: Boolean,       // 必填
  dependsOnTaskTitles: StringArray,
  acceptanceCriteria: StringArray          // 必填
}
```

**复杂度评估**：
- 顶层 9 个必填字段
- 嵌套 `suggestedTasks` 数组，每个元素 11 个字段（8 个必填）
- 总计约 **20 个字段**需要正确生成
- 需要符合严格的 JSON Schema 约束（`NonEmptyString`、枚举值等）

### 4. 系统架构师的角色冲突

#### Agent 定义
```typescript
{
  key: 'architect',
  name: '系统架构师',
  role: '从架构视角分析当前项目结构与主链路，并给出架构方面的想法和建议。',
  description: '负责帮助用户理解当前项目的目录职责、核心入口、主运行链路、模块边界和架构风险。',
  capabilityIds: ['cap-brief', 'cap-dry-run']
}
```

#### Prompt 引导
- `generic-llm-runtime.service.ts:1045-1047`：
  ```typescript
  input.expectedOutput.kind === 'task_brief'
    ? 'When the user asks to analyze, understand, or become familiar with a project/repository architecture, assign exactly one architect task. The architect scenario is only: analyze the current project structure and main execution/collaboration path from an architecture viewpoint, then provide architecture ideas, risks, and suggestions grounded in workspaceManifest/projectMap/selectedEvidenceContents. Do not add a separate review/test task unless the user explicitly asks for validation.'
    : ''
  ```

#### 冲突点
- **角色定位**：系统架构师是「分析者」，擅长「架构理解和建议」
- **输出要求**：`task_brief` 要求「任务拆解」，包含 `suggestedTasks`（需要派发给其他 Agent 的任务）
- **认知负担**：模型需要同时完成：
  1. 架构分析
  2. 任务拆解
  3. 生成复杂的 JSON 结构
  4. 符合严格的 Schema 约束

### 5. 模型能力限制

根据用户内存记录：
- 本地 7B 模型有 5 分钟超时窗口
- 480 秒（8 分钟）等待时长超过典型窗口
- 小模型对复杂 Schema 的生成能力有限

### 6. 上下文过载

`brief_generation` 阶段的上下文可能包含：
- L1: 会话目标、任务上下文、导航
- L2: 项目地图
- L3: Grounded evidence（代码片段、文件内容）
- L4-L6: 其他上下文层

如果 Workspace 较大，上下文可能超出模型处理能力。

## 问题优先级

**P0 - 阻塞级**

原因：
1. 系统架构师是核心流程的一部分（brief_generation）
2. 失败导致整个任务链路中断
3. 影响用户体验（8 分钟等待后失败）

## 修复建议

### 短期方案（P0 - 立即修复）

#### 方案 A：简化 task_brief Schema 的架构师场景

**思路**：为架构师提供一个简化的输出 Schema

1. **新增 `architecture_analysis` RuntimeOutput kind**
   ```typescript
   ArchitectureAnalysisOutputSchema = {
     schemaVersion: '1.0',
     kind: 'architecture_analysis',
     projectOverview: NonEmptyString,        // 项目定位
     directoryStructure: StringArray,         // 目录职责
     coreEntryPoints: StringArray,            // 核心入口
     mainExecutionPath: NonEmptyString,       // 主链路
     moduleBoundaries: StringArray,           // 模块边界
     architectureRisks: StringArray,          // 架构风险
     evolutionConstraints: StringArray,       // 演进约束
     readingPath: StringArray,                // 阅读路径
     suggestions: StringArray                 // 建议
   }
   ```

2. **修改 orchestrator 调用逻辑**
   - 检测到用户意图是「架构分析」时，使用 `architecture_analysis` 而非 `task_brief`
   - 接收到 `architecture_analysis` 后，由 coordinator 二次加工成 `task_brief`

**优点**：
- 字段更符合架构师的角色定位
- 结构更简单（9 个字段 vs 20+ 个字段）
- 模型更容易生成

**缺点**：
- 需要引入新的 RuntimeOutput kind
- 需要修改编排逻辑

#### 方案 B：为 task_brief 提供更强的 Prompt 引导

**思路**：增强 `buildRemoteSystemPrompt()` 中针对 `task_brief` 的指令

修改位置：`apps/server/src/modules/runtimes/generic-llm-runtime.service.ts:1045-1047`

```typescript
input.expectedOutput.kind === 'task_brief'
  ? [
      'CRITICAL: You MUST return a valid task_brief JSON object with ALL required fields.',
      'Required structure:',
      '  - goal: string (non-empty, describe the overall objective)',
      '  - scope: string[] (what is included)',
      '  - outOfScope: string[] (what is excluded)',
      '  - constraints: string[] (technical/resource constraints)',
      '  - acceptanceCriteria: string[] (how to verify success)',
      '  - risks: string[] (potential issues)',
      '  - openQuestions: string[] (unresolved items)',
      '  - suggestedTasks: array of at least 1 task object, each with:',
      '    * title: string (non-empty)',
      '    * description: string (non-empty)',
      '    * suggestedAgentKey: string or null',
      '    * routingMode: "coordinator_controlled" | "agent_suggested" | "agent_delegated" | null',
      '    * assignmentReason: string or null',
      '    * contextRequirements: string[]',
      '    * verificationPlan: string[]',
      '    * riskNotes: string[]',
      '    * requiresUserConfirmation: boolean',
      '    * dependsOnTaskTitles: string[]',
      '    * acceptanceCriteria: string[]',
      '',
      'When the user asks to analyze, understand, or become familiar with a project architecture:',
      '  1. Set goal to: "理解项目架构、主链路和模块边界"',
      '  2. In scope: list the key directories/modules to analyze',
      '  3. Create exactly ONE suggested task with:',
      '     - title: "分析项目架构"',
      '     - description: detailed analysis plan',
      '     - suggestedAgentKey: "architect"',
      '     - routingMode: "coordinator_controlled"',
      '     - requiresUserConfirmation: false',
      '     - acceptanceCriteria: ["架构图已生成", "主链路已梳理", "风险已识别"]',
      '',
      'DO NOT deviate from this structure. DO NOT add fields not in the schema.',
      'DO NOT return architecture analysis directly - wrap it in task_brief format.'
    ].join('\n')
  : ''
```

**优点**：
- 无需修改 Schema
- 快速部署

**缺点**：
- Prompt 过长可能增加 token 消耗
- 强制引导可能限制模型灵活性

#### 方案 C：增加 Schema Repair 重试次数

**思路**：提高 `llmSchemaRepairAttempts()` 的默认值

修改位置：`apps/server/src/common/runtime-config.ts:120-123`

```typescript
export function llmSchemaRepairAttempts() {
  const parsed = Number(process.env.LLM_SCHEMA_REPAIR_ATTEMPTS ?? 3); // 从 1 改为 3
  return Number.isFinite(parsed) ? Math.max(0, Math.min(5, Math.floor(parsed))) : 3;
}
```

**注意**：这只影响 Generic LLM Runtime，不影响 Claude Code CLI 的内部 5 次重试。

**优点**：
- 简单
- 增加成功概率

**缺点**：
- 治标不治本
- 增加 token 消耗和等待时间

### 中期方案（P1 - 架构优化）

#### 方案 D：拆分 brief_generation 阶段

**思路**：将「架构分析」和「任务拆解」分为两个独立阶段

1. **Phase 1: architecture_analysis**
   - Agent: architect
   - Output: `architecture_analysis` (简化 Schema)
   
2. **Phase 2: brief_generation**
   - Agent: coordinator
   - Input: architecture_analysis 结果
   - Output: `task_brief`

**优点**：
- 职责清晰
- 每个 Agent 专注自己擅长的事
- 降低单次调用的复杂度

**缺点**：
- 增加流程长度
- 需要修改编排逻辑

#### 方案 E：动态调整 Schema 复杂度

**思路**：根据任务类型动态简化 Schema

例如：
- 架构分析任务：`suggestedTasks` 最少 1 个，字段简化
- 复杂需求：`suggestedTasks` 可以多个，字段完整

实现：
- 在 `runtimeOutputSchema()` 中根据 `input.contextEnvelope.L1.taskContext.domain` 动态生成 Schema

**优点**：
- 灵活
- 保持统一的 RuntimeOutput kind

**缺点**：
- 实现复杂
- 需要维护多个 Schema 变体

### 长期方案（P2 - 模型升级）

#### 方案 F：切换到更强大的模型

**建议**：
- 将 brief_generation 阶段的模型从本地 7B 切换到云端大模型（Claude Sonnet 5、GPT-4 等）
- 配置 `executionTarget.modelId` 为高能力模型

**优点**：
- 根本解决能力问题
- 提高生成质量和稳定性

**缺点**：
- 增加成本
- 依赖外部服务

## 验证计划

### 测试用例

1. **基线测试**：当前失败场景复现
2. **简化 Schema 测试**：方案 A
3. **增强 Prompt 测试**：方案 B
4. **增加重试测试**：方案 C
5. **回归测试**：确保不影响其他 RuntimeOutput kinds

### 验证指标

- [ ] 系统架构师能稳定生成 task_brief
- [ ] 生成时间 < 120 秒
- [ ] Schema 验证通过率 > 95%
- [ ] 不影响其他 Agent 的结构化输出

## 推荐行动

### 立即执行（今天）

1. **实施方案 B**：增强 Prompt 引导（最快，风险最低）
2. **实施方案 C**：提高 Schema Repair 重试次数（辅助）
3. **记录详细日志**：在 `generic-llm-runtime.service.ts` 中增加诊断日志
   - 记录每次 Schema repair 的具体错误
   - 记录模型输出的原始内容（sanitized）

### 本周完成

4. **实施方案 A**：新增 `architecture_analysis` RuntimeOutput kind（根本解决）
5. **更新测试**：补充针对 task_brief 的合同测试

### 下周评估

6. **评估方案 D**：拆分阶段的可行性
7. **评估方案 F**：模型升级的成本和收益

## 相关文档

- `packages/shared/src/runtime-contracts/output-contracts.ts` - RuntimeOutput Schema 定义
- `apps/server/src/modules/runtimes/generic-llm-runtime.service.ts` - Generic LLM Runtime 实现
- `apps/server/src/modules/orchestrator/orchestrator.service.ts` - 编排逻辑
- `packages/shared/src/default-agent-presets.ts` - Agent 预设定义
- `.claude/CLAUDE.md` - Harness Engineering 协议

## 附录：诊断命令

```bash
# 查看当前配置
grep -E "LLM_SCHEMA_REPAIR_ATTEMPTS|LLM_MAX_RETRIES|CLAUDE_CODE_ENABLED" .env

# 查看 Runtime 日志
tail -f apps/server/runtime-*.log

# 运行类型检查
npm run typecheck

# 运行相关测试
npm run test -- generic-llm-runtime.service.spec.ts
npm run test -- task-brief
```
