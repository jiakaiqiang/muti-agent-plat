# GC-01 共享消息、Tag 与附件合同 Task v1

> [Spec](../product/group-chat-attachment-skill-agent-t01-contracts-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t01-contracts-plan-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t01-contracts-checklist-v1.md)

> 状态：已完成（2026-09-22）

## 任务目标

在共享包中落地消息指令和引用合同，形成后续 13 个任务的唯一类型基础。

## 10–15 分钟执行清单

1. 搜索现有消息、附件、mention、skill 类型，确认不重复命名。
2. 在 `packages/shared/src/contracts.ts` 增加最小类型集合。
3. 增加 Skill ≤ 1 的纯校验函数，并导出。
4. 添加 3–5 个合同测试：空消息、单 Skill、多 Agent、非法多 Skill、附件状态。
5. 运行共享包定向 typecheck/test，记录结果。

## 交付物

- 共享合同类型和校验函数。
- 定向单测。
- 本任务 checklist 中的命令和证据。

## 停止条件

如果发现既有合同已经覆盖全部字段，只补缺失字段和测试，不新建第二套合同。

## 完成定义

前后端可以导入同一组引用类型；非法多个 Skill 在进入编排前可被确定性拒绝。
