# GC-01 共享消息、Tag 与附件合同 Spec v1

> 任务：GC-01 | 预计：10–15 分钟 | 前置：无
> [总路线图](../roadmap/group-chat-attachment-skill-agent-sdd-roadmap-v1.md) · [Plan](../../docs/design/group-chat-attachment-skill-agent-t01-contracts-plan-v1.md) · [Task](../../docs/implementation/group-chat-attachment-skill-agent-t01-contracts-task-v1.md) · [Checklist](../../docs/quality/group-chat-attachment-skill-agent-t01-contracts-checklist-v1.md)

## 目标

建立前后端共享的消息指令、Skill/Agent Tag 和附件引用合同，使后续任务都基于稳定 ID 和显式状态工作。

## 范围

- 新增或扩展用户消息指令结构。
- 定义 `SkillRef`、`AgentRef`、`AttachmentRef`、图片识别状态和协同任务引用。
- 保证结构化数据可序列化、反序列化并保留未知字段兼容性。

## 行为要求

- 一条消息的 Skill 引用最多一个。
- Agent 引用允许零个或多个。
- 附件引用允许零个或多个，并包含附件类型、ID、文件名和状态。
- 可读文本与结构化引用分离保存。
- 图片识别摘要只作为上下文字段，不允许被用户编辑字段覆盖。

## 验收标准

- `GC01-AC1`：共享类型覆盖 Skill、Agent、附件和消息指令。
- `GC01-AC2`：类型能表达上传中、识别中、完成、失败和删除状态。
- `GC01-AC3`：无 Skill、无 Agent、无附件的普通消息仍合法。
- `GC01-AC4`：非法的多个 Skill 引用可被确定性校验拒绝。
- `GC01-AC5`：前后端共用类型编译通过。

## 非目标

- 不实现上传接口、图片识别、Skill 注册或 UI。
- 不在本任务中改变既有历史消息的存储格式；只提供兼容迁移边界。
