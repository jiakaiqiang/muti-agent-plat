# M3-03 · `AgentTask.assignee/assignedBy` 双写字段

## 目标

在 `contracts.ts:413-414` 附近为 `AgentTask` 加 `assignee?: ActorRef; assignedBy?: ActorRef;`；旧字段 `assigneeAgentId`、`assignedByAgentId` 加 `@deprecated`。

## 依赖

M3-02。

## 前置阅读

- `contracts.ts:413` 附近的 `AgentTask` 定义

## 测试步骤（红）

`agent-task-actor.spec.ts`：

1. `AgentTask` 类型可接受 `{assignee: {type:'agent', id:'a1'}, ...}`
2. `assignee.type='user'` 也合法
3. `assignedBy.type='system'`（预留 R7 autopilot）合法

## 实现要点（绿）

在 `AgentTask` 加两个可选字段 + deprecated 注释。

## 验收目标

- [ ] 类型测试绿
- [ ] 全项目 typecheck 绿
- [ ] `docs/contracts/data-contract-v0.1.md` 追加说明

## 时间估算

10 分钟。

## 提交信息

```
task(M3-03): AgentTask.assignee/assignedBy 双写字段
```
