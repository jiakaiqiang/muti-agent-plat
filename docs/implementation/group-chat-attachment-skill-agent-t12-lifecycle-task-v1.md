# GC-12 历史、生命周期与删除一致性 Task v1

> [Spec](../product/group-chat-attachment-skill-agent-t12-lifecycle-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t12-lifecycle-plan-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t12-lifecycle-checklist-v1.md)

## 任务目标

补齐历史消息、附件删除、Skill/Agent 停用和群聊生命周期的一致性守卫。

## 10–15 分钟执行清单

1. 复核消息、Skill、Agent、附件的展示快照和稳定引用。
2. 增加历史 Skill 使用最新版本的校验。
3. 增加不可用 Agent 历史执行拒绝。
4. 串接消息删除和附件同步删除。
5. 增加群聊删除清理和新 Agent 全历史只读访问测试。

## 完成定义

历史可追溯但不绕过当前权限；删除、停用、群聊结束和重复清理均可恢复且幂等。

## 实施状态

已完成。消息删除使用可审计墓碑保留稳定事件 ID，同时清空正文中的可执行引用；附件按消息/群聊同步进入 deleted 状态；历史 Skill/Agent/附件引用按当前状态重新解析；群聊删除结束临时 Agent 关系并保留主协调 Agent；新增消息不能重新引用已失效附件。自动化验收证据已回填到 checklist。
