# Human Intervention Binding 人工干预绑定

> 最后修改时间：2026-06-11 14:47:47 +08:00
> 修改人：Codex
> 修改的 Agent：Codex

1. 高风险动作执行前调用 `/check`。
2. 出现 `CAPABILITY_REQUIRES_CONFIRMATION` 时向用户暴露 `approvalKey`。
3. 记录理由、范围、风险与可选项。
4. 用户决策后调用 `/approve`。
5. 落盘 `approve_high_risk_capability` 证据。
6. 实际执行必须引用对应的 `approvalKey`。

## REQUIRE_USER_CONFIRMATION

开启 `REQUIRE_USER_CONFIRMATION` 时，高风险动作的人工审批是必须的，即使 `ENABLE_HIGH_RISK_TOOLS` 已经允许了该工具类别也不能跳过。

## 示例

- `tool.file_write` 必须展示路径与内容摘要。
- `tool.command_run` 必须展示命令、参数、`cwd` 与预期副作用。

## 验收要点

- 确认理由清晰可读。
- 用户选择被完整记录。
- 执行环节回链到 `approvalKey`。
