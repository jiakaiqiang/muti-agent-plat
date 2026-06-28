# Rule Change Log

> 记录 Harness Engineering 长闭环回写动作。

## GOV-2026-06-28-001

- 日期：2026-06-28
- 决策类型：adjust
- 触发控制面：Entropy Management -> Architecture / Context / Feedback
- 触发原因：工具风险语义和 Agent 命名存在漂移，导致模板与 03 标准命名、05 工具治理不一致。
- 证据来源：
  - `docs/harness-engineering/agent-体系审计与改进方案.md`
  - 本次治理检查中对 `.claude/harness-engineering/**` 的残留旧名和风险分级扫描
- 回写位置：
  - `.claude/harness-engineering/architecture-constraints/05-tool-governance.md`
  - `.claude/harness-engineering/architecture-constraints/capability-binding/tool-governance-binding.md`
  - `.claude/harness-engineering/architecture-constraints/capability-binding/human-intervention-binding.md`
  - `.claude/harness-engineering/**/templates/*.md`
  - `.claude/harness-engineering/architecture-constraints/10-agent-working-protocol.md`
  - `.claude/harness-engineering/entropy-management/delivery-memory/*.md`
- 变更摘要：
  - 将 `tool.file_write` / `tool.command_run` 从固定高风险改为“基础中风险 + 上下文升级高风险”。
  - 将模板中的 `requirements`、`backend`、`frontend`、`test`、`notification` 等历史角色名统一为 7 个标准 Agent。
  - 建立 governance 记录载体，避免长闭环回写无日志。
- 影响范围：
  - 仅文档治理和模板语义，不改业务代码。
  - 后续任务应按 03 标准 Agent 名和 05 上下文风险模型执行。
- 后续验证：
  - 下一次 Harness 文档任务后检查是否仍出现旧 Agent 名。
  - 下一次涉及文件写入或命令执行的交付后，检查 Implementation Summary 是否记录中风险留痕和高风险确认。
