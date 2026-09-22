# GC-11 取消、失败重试与重新汇总 Task v1

> [Spec](../product/group-chat-attachment-skill-agent-t11-retry-summary-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t11-retry-summary-plan-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t11-retry-summary-checklist-v1.md)

## 任务目标

补齐协同任务的取消、失败 Agent 重试和主 Agent 版本化重新汇总。

## 10–15 分钟执行清单

1. 为任务和 Agent 增加 cancelled/failed/retry 状态转换。
2. 保留已完成结果，取消时生成临时主 Agent 汇总。
3. 增加失败 Agent 单独 retry 入口和新 attempt。
4. 增加用户触发的 re-summarize 入口。
5. 保存新汇总版本和纳入的成功结果 ID。
6. 增加状态机和迟到结果测试。

## 完成定义

失败、取消和重试都可在任务面板中追踪；只有用户主动重新汇总才会追加新的主 Agent 汇总。

## 已交付实现

- Server `SessionsService` 增加 `cancelCollaboration`、`retryCollaborationAgent`、`resummarizeCollaboration`，分别产生取消控制事件、隔离的 `task_reworked` 新 attempt，以及不可变的主 Agent 汇总事件。
- 增加三个 HTTP 入口：`POST /sessions/:sessionId/collaboration/cancel`、`retry-agent`、`re-summarize`。
- 重试只定位失败 Agent 的失败 attempt，不会自动创建汇总；重新汇总按成功结果 ID 构造新 `summaryVersion`，保留历史版本。
- Web 协同任务面板展示取消/失败/重试状态、临时汇总和手动汇总版本，并提供“重试此 Agent”“重新汇总”操作；已完成结果和历史汇总均可展开查看。
- 增加 Server Service、Web 协同任务模型测试，覆盖取消保留结果、重试隔离、手动汇总版本追加和摘要去重。
