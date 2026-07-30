# Session Alignment 会话状态对齐

> 最后修改时间：2026-07-13 18:47:00 +08:00
> 修改人：Codex
> 修改的 Agent：Codex

## 目的

本文档把 `SessionStatus` 映射到 Harness 的阶段。即使其他项目的状态命名不同，也能复用同一套映射。

## 状态矩阵

| SessionStatus | Harness 阶段 | 含义 |
| --- | --- | --- |
| DRAFT_INPUT | requirement | 输入已存在，但还没形成 intent contract。 |
| AGENT_DISCUSSING | requirement / design | Agent 正在澄清目标与约束。 |
| WAIT_USER_CONFIRM | human_intervention | brief 就绪，等待用户确认。 |
| WAIT_WORKFLOW_SELECT | planning / human_intervention | brief 已确认，等待用户选择本次执行使用的工作流。 |
| WAIT_WORKFLOW_STEP_CONFIRM | verification / human_intervention | 当前工作流环节已输出到群聊，等待用户确认、提出修改或终止。 |
| REVISING_BRIEF | requirement | intent contract 需要修订。 |
| EXECUTING | implementation | 已确认的计划正在执行。 |
| POST_REVIEW | review | 正在比对产出与意图、证据。 |
| REWORKING | implementation / verification | 正在处理明确的返工目标。 |
| WAIT_USER_DECISION | human_intervention | 范围、风险或权限需要人工决策。 |
| COMPLETED | delivery | 交付完成，可沉淀记忆。 |
| FAILED | feedback | 失败必须经 07-feedback-loop 路由。 |
| CANCELLED | terminal | 本轮被显式终止。 |
| INTERRUPTED | human_intervention | Runtime、Browser Broker 或平台后端断线后保留上下文并等待未来的用户主动唤醒，不自动续跑。 |

## WAIT_USER_CONFIRM 规则

`WAIT_USER_CONFIRM` 是工程闸口，不只是 UI 状态。进入该状态时，必须能看到目标、范围、约束、验收标准、风险与待解决问题。

## 工作流人工闸口

- `WAIT_WORKFLOW_SELECT` 只允许用户显式选择有效工作流，选择后平台按工作流节点顺序创建并绑定 Agent 任务。
- `WAIT_WORKFLOW_STEP_CONFIRM` 必须先把当前节点的 Agent、环节名称和输出展示到群聊；用户确认后才能推进下一节点，提出修改时只重跑当前节点。
- 恢复服务和队列重试不得把上述状态自动转换为 `EXECUTING`，否则会绕过人工确认。
