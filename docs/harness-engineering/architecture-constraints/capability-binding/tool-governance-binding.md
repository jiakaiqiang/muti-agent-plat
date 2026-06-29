# Tool Governance Binding 工具治理绑定

> 最后修改时间：2026-06-11 14:47:47 +08:00
> 修改人：Codex
> 修改的 Agent：Codex

## 逐能力策略矩阵

| capability key | riskLevel | 策略 |
| --- | --- | --- |
| brief.generate | low | 允许执行，需要可追溯的产出。 |
| message.route | low | 允许执行，需要记录路由理由。 |
| runtime.dry_run | medium | 允许执行，需要留存调用日志。 |
| test.report | medium | 允许执行，需要把证据映射到对应任务。 |
| review.post | medium | 允许执行，需要独立的评审决策。 |
| notification.feishu_draft | medium | 只允许生成草稿，发送必须由人工确认。 |
| tool.file_write | high | 必须经过确认，并限定在工作区边界内。 |
| tool.command_run | high | 必须确认命令、cwd 与副作用。 |

## resolve 与 checkInvocation

`resolve` 把 Agent 的能力映射到能力定义。`checkInvocation` 决定当前调用是允许、阻止还是需要确认。

## CapabilityRiskLevel 风险等级

low、medium、high 三档必须按工程策略而非业务语义解释。

## 硬性规则

- 高风险能力不允许 Agent 自我审批。
- blocked 状态的能力不允许绕过。
- medium 风险必须留下证据。
