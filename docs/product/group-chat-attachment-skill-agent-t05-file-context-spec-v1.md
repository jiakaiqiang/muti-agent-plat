# GC-05 文件按需读取与上下文引用 Spec v1

> 任务：GC-05 | 预计：10–15 分钟 | 前置：GC-03
> [总路线图](../roadmap/group-chat-attachment-skill-agent-sdd-roadmap-v1.md) · [Plan](../../docs/design/group-chat-attachment-skill-agent-t05-file-context-plan-v1.md) · [Task](../../docs/implementation/group-chat-attachment-skill-agent-t05-file-context-task-v1.md) · [Checklist](../../docs/quality/group-chat-attachment-skill-agent-t05-file-context-checklist-v1.md)

## 目标

让文件自动挂载为当前消息上下文，但只在 Agent 真正需要时按文件 ID 读取原始内容。

## 行为要求

- 文件消息自动包含附件引用和元数据。
- 上传时不自动提取全文、不自动生成摘要。
- Agent 使用文件工具按 ID 读取文件。
- 文件读取必须校验群聊和附件权限。
- 文件读取结果不应改变原始文件元数据。

## 验收标准

- `GC05-AC1`：消息上下文包含文件 ID、名称、类型和大小。
- `GC05-AC2`：无文件引用时不触发文件读取。
- `GC05-AC3`：有引用时按需读取原始二进制。
- `GC05-AC4`：跨群聊或已删除附件读取被拒绝。
- `GC05-AC5`：只发送文件也可以进入处理链路。

## 非目标

- 不在本任务实现 Office/PDF 文本解析。
- 不把完整文件内容默认注入每次模型请求。
