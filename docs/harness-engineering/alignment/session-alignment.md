# Session Alignment 会话状态对齐

> 最后修改时间：2026-06-11 14:47:47 +08:00
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
| REVISING_BRIEF | requirement | intent contract 需要修订。 |
| EXECUTING | implementation | 已确认的计划正在执行。 |
| POST_REVIEW | review | 正在比对产出与意图、证据。 |
| REWORKING | implementation / verification | 正在处理明确的返工目标。 |
| WAIT_USER_DECISION | human_intervention | 范围、风险或权限需要人工决策。 |
| COMPLETED | delivery | 交付完成，可沉淀记忆。 |
| FAILED | feedback | 失败必须经 07-feedback-loop 路由。 |
| CANCELLED | terminal | 本轮被显式终止。 |

## WAIT_USER_CONFIRM 规则

`WAIT_USER_CONFIRM` 是工程闸口，不只是 UI 状态。进入该状态时，必须能看到目标、范围、约束、验收标准、风险与待解决问题。
