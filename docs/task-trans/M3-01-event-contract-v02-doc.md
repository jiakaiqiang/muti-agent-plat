# M3-01 · event-contract v0.2 双写迁移文档

## 目标

在 `docs/contracts/event-contract-v0.1.md` 追加 v0.2 章节（不改 v0.1 已发布内容），说明 `actor` 字段引入、双写策略、弃用字段清单、v0.3 移除时间点。**仅文档。**

## 依赖

M2-06 已合并。

## 前置阅读

- `docs/contracts/event-contract-v0.1.md` 现有结构
- 上游设计 5.1

## 测试步骤（红）

Grep 验证：
```bash
grep -n "v0.2\|actor\|ActorRef\|deprecated" docs/contracts/event-contract-v0.1.md
```
应无 v0.2 章节（红）。

## 实现要点（绿）

追加"v0.2 迁移说明"章节：

- **新增**：`CollaborationEvent.actor?: ActorRef`、`AgentTask.assignee?: ActorRef`、`AgentTask.assignedBy?: ActorRef`
- **推导规则**：见 M3-04 具体实现
- **弃用**：`fromAgentId`（第 M3-02 号任务后仅代码内部使用）、`assigneeAgentId`、`assignedByAgentId`——**v0.2 仍读写；v0.3 移除**
- **前端契约**：优先读 `actor`；读不到回退旧字段
- **变更日志**：在文档末尾加一条 v0.2 dated 记录

## 验收目标

- [ ] `event-contract-v0.1.md` grep 命中 `v0.2`、`actor`、`deprecated`
- [ ] 无代码改动

## 时间估算

10 分钟。

## 提交信息

```
task(M3-01): event-contract v0.2 双写迁移说明
```
