# Pluggable Engineering Runtime Memory

本文档记录群聊 Agent、ContextPack、Codex/Claude Code 等工程运行时相关的长期架构记忆，供后续 AI 会话按需加载。

## 核心结论

Agent Cluster 不应把 Codex 固化为唯一主 Agent。Codex 只是首个或默认的 Engineering Agent Runtime 实现。后续可以切换到 Claude Code、Gemini CLI、Aider、自定义 CLI、Generic LLM 或 Human Runtime。

稳定边界如下：

- Agent Cluster 负责群聊协作、任务状态、用户确认、审计事件、能力治理、摘要记忆和交付流程。
- 被选中的 Engineering Runtime 负责项目读取、代码修改、验证命令、diff/artifact 输出和读取轨迹。
- 协作层依赖统一 runtime 协议，不依赖 Codex 专有行为。

## ContextPack 原则

`ContextPack` 必须是 bounded navigation packet，不是项目 dump。

允许放入：

- 用户目标和当前任务；
- 验收标准和约束；
- 相关路径、候选文件、合同、测试和验证命令；
- 有界的最小证据内容；
- token budget、能力策略和阶段计划。

禁止放入：

- 完整仓库文件内容；
- 大规模 workspace 文件列表；
- 完整事件历史；
- 完整 memory/artifact body；
- 每个群聊 Agent 都重复的大 ContextPack。

## 项目理解方式

工程运行时理解项目时应遵循：

```text
small task packet + project map refs + tool reads + read trace + compact summary
```

而不是：

```text
large ContextPack + full project preload
```

运行时输入应该只包含小型任务包：

- goal；
- current task；
- acceptance criteria；
- constraints；
- allowed workspace root；
- initial candidate paths；
- validation commands；
- budget；
- capability policy。

运行时通过受控工具按需读取文件，例如 `rg`、read file、`git diff`、测试命令和 package script 检查。每次读取应产生可审计 read trace。

## Runtime 选择规则

Engineering Runtime 选择优先级：

```text
Agent override
  > Session override
  > Project default
  > Global default
```

切换 runtime 只能改变 adapter 实现，不应改变群聊协作流程、任务状态机、审计语义或交付流程。

## Token 安全规则

为避免上下文超限，必须同时满足：

- 群聊 Agent 使用 role-specific context slice，不共享同一份大包；
- `selectedEvidenceContents` 有 item count、per-item chars、total chars 和去重限制；
- `workspaceSnapshot` 面向 runtime 时保持 manifest-only；
- `relevantEvents`、`relevantMemories`、`artifacts` 只传相关摘要切片；
- debug payload 与 runtime payload 分离；
- `CONTEXT_INSUFFICIENT` 重试只补充 requested refs，不能升级成 whole workspace 注入；
- 正常 trim 失败后必须支持 emergency navigation-only pack。

## 相关设计文档

- `docs/design/codex-style-agent-collaboration-architecture-v1.md`
- `docs/design/context-router-target-design-v1.md`
- `docs/design/agent-collaboration-target-design-v1.md`
- `docs/design/agent-cluster-system-design-v1.md`
