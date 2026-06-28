# Tool Governance Binding

> 最后修改时间：2026-06-11 14:47:47 +08:00
> 修改人：Codex
> 修改的 Agent：Codex

## 逐能力策略矩阵

| capability key | riskLevel | policy |
| --- | --- | --- |
| brief.generate | low | Allowed with traceable output. |
| message.route | low | Allowed with routing reason. |
| runtime.dry_run | medium | Allowed with invocation log. |
| test.report | medium | Allowed with evidence mapping. |
| review.post | medium | Allowed with independent decision. |
| notification.feishu_draft | medium | Draft only; send requires human confirmation. |
| tool.file_write | high | Requires confirmation and workspace boundary. |
| tool.command_run | high | Requires confirmation of command, cwd, and side effects. |

## resolve and checkInvocation

resolve maps agent capabilities to definitions. checkInvocation decides if the current request is allowed, blocked, or requires confirmation.

## CapabilityRiskLevel

The risk levels low, medium, and high must be interpreted as engineering policy.

## Hard Rules

- high risk cannot be self-approved by an agent.
- blocked capability cannot be bypassed.
- medium risk must leave evidence.
