# Agent Harness + Profile 架构可行性建议 v1

> 最后修改时间：2026-06-29
> 修改人：Claude Code
> 修改的 Agent：Claude Code
> 状态：草案 / 等待决策

## 1. 背景

当前 Agent Cluster 内置 10 个默认 Agent，配置来源为 `packages/shared/src/default-agent-presets.ts`，运行时 prompt 直接由 `Agent.profileMarkdown` 拼装。同时项目维护了一套 Harness Engineering 工程协议（`docs/harness-engineering/`），其中 `architecture-constraints/10-agent-working-protocol.md` 规定了每个阶段 Agent 的「必须输入 / 必须输出 / 返工触发」。

**问题**：Harness 工程协议只存在于文档里，并未进入模型实际接收的 prompt。换句话说，模型并不知道项目里有 Harness 协议这件事，行为约束完全靠 `profileMarkdown` 自然语言隐式表达。

本文档评估把架构演进为「Harness（通用协议） + Profile（角色画像）」双层拼装的可行性、收益、风险、实施路径，并给出推荐方案。

## 2. 当前架构现状（Profile-only）

### 2.1 数据层

`default-agent-presets.ts:17` 维护 10 个内置 Agent 的 preset：

```ts
DefaultAgentPreset = {
  id, key, name, role, description,
  tags, abilities, capabilityIds,
  responsibilities, boundaries
}
```

`default-agents.ts:32` 把 preset 用 `profileMarkdown()` 渲染成一段完整 Markdown（角色 / 描述 / 能力 / 能力绑定 / 责任 / 边界 / 标签），写入 `Agent.profileMarkdown`。

### 2.2 拼装层

`apps/server/src/modules/orchestrator/orchestrator.service.ts:3488`：

```ts
systemPrompt: agent.profileMarkdown?.trim() || `${agent.name}: ${agent.role}`
```

`agent.profileMarkdown` 直接等于 `systemPrompt`，**没有任何阶段感知**。

### 2.3 运行层

`apps/server/src/modules/runtimes/generic-llm-runtime.service.ts:606-637` 的 `buildRemoteSystemPrompt` 在 `agent.systemPrompt` 之后追加全局规则文本，并按 `expectedOutput.kind` 用 if-else 分支拼接「agent_message / task_brief / task_execution_result / …」专属指令。这部分逻辑：

- 与具体 Agent 角色无关。
- 与 `AgentRunPhase` 没有显式映射（只按 output kind 分）。
- 硬编码在 runtime 服务里，Mock / Codex / Claude Code adapter 各自独立。

### 2.4 关键问题

| 现象 | 影响 |
| --- | --- |
| Harness 协议（必须输入 / 输出 / 返工触发）只存在于文档 | 模型不可见，行为约束靠隐式自然语言 |
| 自定义 Agent（用户从 UI 新建）只走 `agents.service.ts:187` 的三行通用模板 | 自定义 Agent 完全没有 Harness 行为约束 |
| Phase 专属规则散布在 runtime 服务里 | 切换 runtime adapter 时容易丢失或不一致 |
| Profile 同时承担「角色个性」和「通用工作纪律」 | 改通用规则要改 10 份 preset，改个性要从一堆通用语句里挑 |

## 3. 提议架构（Harness + Profile）

### 3.1 概念定义

- **Profile**：表达 Agent 个性，回答「这个 Agent 是谁、擅长什么、不做什么」。维持现有 preset 字段（role / abilities / responsibilities / boundaries / capabilityIds / tags），但**收敛**——只保留角色特有的内容。
- **Harness**：表达通用工程纪律，回答「在某个阶段、做某种事情时，所有 Agent 都必须遵守什么」。按 `AgentRunPhase` 维度组织，每个阶段包含 `mustInputs / mustOutputs / reworkTriggers / overreachRules`，以及跨阶段的 `commonRules`（不擅自扩大范围、不绕过工具治理等 8 条）。

### 3.2 数据模型（建议放在 `packages/shared/src/harness-protocols.ts`）

```ts
type HarnessCommonRule = {
  id: string;          // 例如 'rule.stage_isolation'
  rule: string;        // 自然语言规则
  rationale?: string;  // 为什么有这条
};

type HarnessPhaseProtocol = {
  phase: AgentRunPhase;
  stage: string;       // requirement / design / planning / implementation / verification / review / delivery
  mustInputs: string[];
  mustOutputs: string[];
  reworkTriggers: string[];
  overreachRules: string[];
};

export const harnessCommonRules: HarnessCommonRule[] = [/* 8 条通用纪律 */];
export const harnessPhaseProtocols: Record<AgentRunPhase, HarnessPhaseProtocol> = {/* 各阶段 */};
```

### 3.3 拼装规则

新增一个 `apps/server/src/modules/agents/prompt-builder.service.ts`（或挂在 `AgentsService` 上）：

```ts
buildSystemPrompt(agent: Agent, phase: AgentRunPhase): string {
  return [
    '# Harness 通用纪律',
    harnessCommonRules.map(r => `- ${r.rule}`).join('\n'),
    '',
    `# ${harnessPhaseProtocols[phase].stage} 阶段协议`,
    renderPhaseProtocol(harnessPhaseProtocols[phase]),
    '',
    '# 角色画像',
    agent.profileMarkdown
  ].join('\n');
}
```

`orchestrator.service.ts:3488` 的 `toRuntimeAgent` 改为调用 `buildSystemPrompt(agent, phase)`，`phase` 来自当前调度上下文。

### 3.4 数据示例（Verification Agent 在 task_execution 阶段）

```text
# Harness 通用纪律
- 只处理自己阶段内的问题。
- 不擅自修改上游阶段结论。
- 不扩大需求范围。
- 不绕过工具治理。
- 不把待确认问题当成已确认事实。
- 不用口头总结替代结构化交接产物。
- 发现上游问题时，通过 Feedback Loop 回退。
- 结束阶段时，必须说明产物、风险、未决问题和下游注意事项。

# verification 阶段协议
## 必须输入
- Intent Contract
- Design Plan
- Implementation Summary
- 待验证项

## 必须输出
- Verification Result
- 验收证据
- 缺陷列表
- 阻塞原因
- 建议回退阶段

## 返工触发
- 验收标准未满足
- 证据不足
- 验证方式不可靠
- 实现结果与设计不一致

## 越权与返工
- 发现需求遗漏时回退到 requirement 阶段，不擅自补充验收标准。
- 发现设计缺口时回退到 design 阶段，不在验证阶段重新设计。

# 角色画像
# 质量检测工程师

## 角色定位
制定验证策略，执行质量检查，发现回归风险，并输出可追踪的验收证据。

## 描述
负责确认实现是否满足需求、合同、边界条件和关键用户路径。

（其余 profile 字段……）
```

## 4. 关键差异对比

| 维度 | 当前 Profile-only | Harness + Profile |
| --- | --- | --- |
| 通用协议在哪 | 只在 docs，模型不可见 | TS 常量，运行时注入 prompt |
| 阶段协议在哪 | runtime 里硬编码 if-else（按 output kind 分） | harness 表里，按 phase 索引 |
| 自定义 Agent 行为约束 | 三行默认模板，基本没有 | 自动继承 harness，profile 只补角色 |
| Profile 字段职责 | 角色 + 工作规则混在一起 | 只承担角色个性 |
| 协议演化路径 | 改 docs → 没影响 | 改 docs → 同步常量 → 重新拼装 |
| Prompt 长度（remote） | 取决于 profile 详尽度 | 较稳定，通用 + 阶段 + 角色三段 |
| Phase 感知能力 | 隐式，靠 expectedOutput.kind | 显式，按 AgentRunPhase |
| 测试粒度 | 每个 Agent profile 各自测 | harness 表测一次，profile 测一次 |
| 与 Harness Engineering 边界 | 隐式偏离（docs 权威，代码看不见） | 显式镜像（单向 docs → TS 常量） |

## 5. 与 Harness Engineering 边界的关系

根据 `docs/harness-engineering/00-boundary-and-principles.md:32` 的硬规则 3：「用户明确要求产品化之前，不把 Harness 设计成 API、模块、页面或数据库」。

### 5.1 不违反的边界

本提议方案严格停在「常量 + 拼装函数」层：

- `harnessProtocols` 是 TypeScript 常量，没有 schema、没有 API、没有 UI。
- `buildSystemPrompt` 是纯函数，不暴露 HTTP 端点。
- Harness 协议的**权威来源仍是 `docs/harness-engineering/`**，代码侧只是镜像副本。
- 不引入「自定义 harness」概念，用户不能在前端编辑协议。

### 5.2 不能跨越的边界

如果未来出现以下需求，必须先走 Harness 边界产品化决策，**不能在本方案下偷偷扩张**：

- 把 harness 协议变成数据库表。
- 提供 `POST /harness-protocols` 这样的 API。
- 做前端 UI 让用户编辑协议字段。
- 让协议成为业务运行时的强校验（例如：未通过 harness 校验就阻塞任务推进）。

### 5.3 governance 配套

需要在 `docs/harness-engineering/governance/` 下记录一条规则：

```text
当 architecture-constraints/10-agent-working-protocol.md 修改时，
必须同步更新 packages/shared/src/harness-protocols.ts，
并在 PR 描述里链接两个变更。
```

可以补一个 `tests/harness-engineering/` 下的校验脚本，检测两边字段是否一致。

## 6. 实施路径（分阶段）

### Phase 1 — 最小验证（预计 0.5-1 天）

目标：验证「harness 注入 prompt 是否真正改善了模型行为」。

落点：
- 新建 `packages/shared/src/harness-protocols.ts`，先只填一个阶段（建议从 `verification` 或 `requirement` 开始，行为偏差最大）。
- 新建 `apps/server/src/modules/agents/prompt-builder.service.ts`，导出 `buildSystemPrompt(agent, phase)`。
- 在 `generic-llm-runtime.service.ts` 用 **feature flag**（环境变量 `HARNESS_PROMPT_INJECTION`，默认 false）切换新旧拼装路径。
- 跑 `npm run test:e2e:multi-agent-discussion` 和 `npm run test:e2e:main-chain`，对比开关前后行为。

不做：
- 不动 `default-agent-presets.ts` 任何字段。
- 不改其他 runtime adapter（Codex / Claude Code / Mock）。
- 不删 `buildRemoteSystemPrompt` 里的 if-else。

判断准入下一阶段的标准：
- 模型在验证阶段产出 `Verification Result` 时，字段覆盖率提升（覆盖 mustOutputs 的比例 ≥ 80%）。
- Token 增量在可接受范围（remote 模型 < 1500 tokens，本地模型保持简化路径）。
- 无明显行为退化。

### Phase 2 — 替换主链路（预计 2-3 天）

目标：把 harness 注入扩展到全部 7 个 `AgentRunPhase`，并下沉到所有 runtime adapter 共享。

落点：
- 补全 `harness-protocols.ts` 全部阶段。
- 把 `buildSystemPrompt` 调用点从 runtime 内部上移到 `orchestrator.service.ts:3481` 的 `toRuntimeAgent`，所有 runtime adapter 都从 `input.agent.systemPrompt` 读取。
- 删除 `generic-llm-runtime.service.ts:619-633` 的阶段 if-else（迁移到 harness 表）。
- 默认开启 feature flag（仍保留关闭路径用于回滚）。

不做：
- 仍然不动 preset 字段。
- 不动小模型的 `buildLocalSystemPrompt`（保持极简）。

### Phase 3 — 收敛 Profile（预计 1-2 天）

目标：清理 preset 里和 harness 重复的内容，让 profile 只承担角色个性。

落点：
- 评审每个 preset 的 `responsibilities` 和 `boundaries`，把通用纪律部分删除，只保留角色特有内容。
- 更新 `default-agents.ts:6` 的 `profileMarkdown` 渲染逻辑，输出更紧凑。
- 跑全量 e2e。

判断完成的标准：
- 每个 Agent 的 profile Markdown 行数下降 ≥ 30%。
- 主链路 e2e 全部通过。
- Token 总量比 Phase 2 末期有所下降（因为 profile 收敛了）。

## 7. 影响范围

### 7.1 代码改动清单

| 路径 | 变更类型 | Phase |
| --- | --- | --- |
| `packages/shared/src/harness-protocols.ts` | 新增 | 1 |
| `packages/shared/src/index.ts` | 新增导出 | 1 |
| `apps/server/src/modules/agents/prompt-builder.service.ts` | 新增 | 1 |
| `apps/server/src/modules/agents/agents.module.ts` | provider 注册 | 1 |
| `apps/server/src/modules/runtimes/generic-llm-runtime.service.ts` | 修改 prompt 拼装 | 1-2 |
| `apps/server/src/modules/orchestrator/orchestrator.service.ts` | `toRuntimeAgent` 接受 phase | 2 |
| `apps/server/src/common/runtime-config.ts` | 新增 feature flag | 1 |
| `packages/shared/src/default-agent-presets.ts` | 收敛 responsibilities/boundaries | 3 |
| `tests/harness-engineering/harness-protocols-sync.spec.mjs` | 新增 docs/代码一致性校验 | 1 |

### 7.2 数据迁移

无。Harness 协议是只读常量，无数据库 schema 变更，无持久化数据迁移。`Agent` 实体保持现状。

### 7.3 兼容性

- API 合同（`docs/contracts/api-contract-v0.1.md`）：`Agent` 实体字段不变，`POST /agents` 行为不变。
- Runtime 合同（`docs/contracts/runtime-contract-v0.1.md`）：`AgentRunInput.agent.systemPrompt` 字段语义不变（只是内容变长）。
- 前端：无感知改动。`profileMarkdown` 在前端展示的内容不变（Phase 3 后会变短）。
- 自定义 Agent：自动受益，无需用户操作。

## 8. 风险与缓解

### 8.1 Token 预算

**风险**：harness 注入每次额外增加 800-1500 tokens（remote 模型）。结合 `docs/ai-agent-context/pluggable-engineering-runtime-memory.md` 的 token 预算红线，可能挤压 ContextPack 可用空间。

**缓解**：
- Phase 1 通过 feature flag 量化实测增量。
- 本地小模型保持 `buildLocalSystemPrompt` 极简路径不变。
- 如果超预算，按阶段裁剪 harness 内容（例如只注入 mustInputs/mustOutputs，省略 overreachRules）。

### 8.2 Docs 与代码漂移

**风险**：`10-agent-working-protocol.md` 改了，`harness-protocols.ts` 没跟上，两边描述不一致。

**缓解**：
- 加 `tests/harness-engineering/harness-protocols-sync.spec.mjs`，解析 docs 的章节结构，对比代码常量字段。CI 失败即提醒。
- governance 增加一条规则（见 5.3）。

### 8.3 小模型回归

**风险**：当前 `buildLocalSystemPrompt` 为 Ollama 兼容性做了极简化（`generic-llm-runtime.service.ts:578`）。如果 harness 一刀切注入，小模型可能触发推理模式或超出 num_ctx。

**缓解**：
- `buildSystemPrompt(agent, phase, { variant: 'remote' | 'local' })` 支持变体，local 路径只注入「角色 + 一行核心约束」。
- Phase 1 验证只在 remote 路径开启。

### 8.4 边界滑坡

**风险**：方案落地后，团队习惯了「在代码里改 harness」，逐步出现「harness 用数据库存」「让用户在 UI 编辑 harness」等扩张诉求，违反 Harness Engineering 硬规则 3。

**缓解**：
- `harness-protocols.ts` 文件头加显眼注释：「本文件是 docs/harness-engineering/architecture-constraints/10-agent-working-protocol.md 的镜像，权威源在 docs。不要在此文件加业务逻辑、不要把它接到数据库、不要把它暴露为 API。」
- governance 文档明确禁止边界扩张。
- code review 检查清单加一条：「本 PR 是否把 harness 暴露成了 API / schema / UI？」

### 8.5 phase 难以确定的场景

**风险**：用户消息路由、群聊讨论等场景下，`AgentRunPhase` 可能不明确或一个 turn 涉及多个 phase。

**缓解**：
- harness 表里增加一个 `default` / `discussion` 兜底 phase，覆盖角色边界但不强制阶段产出。
- `buildSystemPrompt` 在 phase 缺失时回退到 `default`，并在日志里记录。

## 9. 验证策略

### 9.1 单测

- `prompt-builder.service.spec.ts`：验证给定 agent + phase，输出包含预期的 harness 段、profile 段。
- `harness-protocols.spec.ts`：验证所有 7 个 phase 都有完整协议，所有 commonRules 唯一。

### 9.2 e2e

- `npm run test:e2e:main-chain`：主链路无回归。
- `npm run test:e2e:multi-agent-discussion`：讨论行为是否更结构化。
- `npm run test:e2e:rework-loop`：返工触发是否更准确。
- `npm run test:e2e:token-budget`：token 预算未越红线。

### 9.3 Token 监控

在 Phase 1 实施时，临时加 console 日志输出每次 `buildSystemPrompt` 的 token 估算（用 `RuntimeUsage.inputTokens` 对比）。导出 CSV 做开启前/后对比。

### 9.4 主观评估

挑 3 个真实场景（需求澄清 / 实现执行 / 验证返工），各跑 5 次，对比开启前后的：
- 产出字段覆盖率（是否包含 mustOutputs 要求的字段）。
- 越权行为发生率（是否擅自做了不该做的事）。
- 返工触发准确度。

由人工评分（1-5 分），导出对比表。

## 10. 决策选项

### 选项 A：接受全部建议（Phase 1 → 2 → 3）

适用：希望长期解决 Agent 行为不一致、并准备承担 token 预算重新摊配的成本。

预期时间：6-8 天。

预期收益：
- 自定义 Agent 自动获得 harness 约束。
- runtime adapter 收敛 phase 逻辑。
- profile 字段更纯粹，未来增删 Agent 更轻。

### 选项 B：只做 Phase 1（feature flag 验证）

适用：先量化收益再决定是否扩张。

预期时间：0.5-1 天。

预期收益：
- 拿到 token 增量与行为改善的实测数据。
- 不动主链路，可随时回滚。

风险：如果 Phase 1 数据不够说服力，可能停在半中间状态，徒增代码复杂度。

### 选项 C：暂不实施，只做文档同步

适用：当前 Agent 行为问题不严重，团队优先级在其他方向。

预期时间：0.5 天。

落点：
- 把 `10-agent-working-protocol.md` 的内容**单向拷贝**进每个内置 preset 的 `responsibilities/boundaries`，让模型至少能从 profile 读到。
- 不改架构，只是把信息从 docs 平移到 preset。

风险：本质是「把 harness 写进 profile」，profile 膨胀，未来要切换更难。**不推荐**。

## 11. 我的推荐

**走选项 B → 根据数据决定是否走 A**。

理由：
- 选项 B 成本极低（0.5-1 天），且通过 feature flag 保证可回滚。
- Phase 1 拿到的 token / 行为数据是 Phase 2 决策的关键输入，没数据就拍板风险大。
- 如果 Phase 1 数据显示模型行为改善明显，且 token 增量在预算内，Phase 2 / 3 的投入有充分依据。
- 如果数据不明显，可以停在 Phase 1，承担小代码复杂度换可观测能力。

不推荐选项 C：把 harness 平移进 preset 等于让 profile 同时承担两种语义，未来分离更难。

## 12. 不做什么

为防止范围漂移，本方案明确**不做**以下事情：

1. 不把 harness 协议变成数据库表、API、前端编辑器（违反 Harness Engineering 硬规则 3）。
2. 不引入「自定义 harness」概念，用户不能修改协议。
3. 不让 harness 校验成为业务运行时的强约束（例如不在 orchestrator 里拦截「未通过 harness 校验」的产出）。harness 是给模型看的，不是给代码用的。
4. 不动 Mock / Codex / Claude Code adapter 的内部逻辑，只通过共享的 `input.agent.systemPrompt` 输入。
5. 不在 Phase 1-2 触碰 `default-agent-presets.ts`，避免一次性大改难以回滚。
6. 不为「未来可能的多语言 harness」「可配置 harness 模板」做提前设计。需要时再说。

## 13. 待用户确认的关键点

实施前需要用户明确：

1. **方向**：选 A / B / C 哪个？（推荐 B）
2. **Phase 1 起点 phase**：从 `verification` 还是 `requirement` 开始？
3. **Token 预算红线**：每次 prompt 注入的 harness 部分上限是多少 tokens？（建议 1500，需要确认）
4. **docs/代码同步策略**：手动同步 + CI 校验，还是写个生成脚本？（建议先手动，量大了再脚本化）
5. **是否需要在 governance 里记录这次架构演进**：建议在 `docs/harness-engineering/governance/rule-change-log.md` 加一条记录。

---

**附录：相关文档**

- 边界与原则：`docs/harness-engineering/00-boundary-and-principles.md`
- Agent 工作协议：`docs/harness-engineering/architecture-constraints/10-agent-working-protocol.md`
- Agent 角色协议：`docs/harness-engineering/architecture-constraints/03-agent-role-protocol.md`
- Prompt 合同：`docs/harness-engineering/context-engineering/prompt-context/agent-prompt-contract.md`
- Token 预算与 Engineering Runtime：`docs/ai-agent-context/pluggable-engineering-runtime-memory.md`
- 当前实现入口：`packages/shared/src/default-agent-presets.ts`、`apps/server/src/modules/agents/agents.service.ts`、`apps/server/src/modules/orchestrator/orchestrator.service.ts:3481`、`apps/server/src/modules/runtimes/generic-llm-runtime.service.ts:606`


