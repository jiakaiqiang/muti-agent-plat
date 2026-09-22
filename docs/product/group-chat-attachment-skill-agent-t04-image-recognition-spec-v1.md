# GC-04 图片内容理解与重试 Spec v1

> 任务：GC-04 | 预计：10–15 分钟 | 前置：GC-03
> [总路线图](../roadmap/group-chat-attachment-skill-agent-sdd-roadmap-v1.md) · [Plan](../../docs/design/group-chat-attachment-skill-agent-t04-image-recognition-plan-v1.md) · [Task](../../docs/implementation/group-chat-attachment-skill-agent-t04-image-recognition-task-v1.md) · [Checklist](../../docs/quality/group-chat-attachment-skill-agent-t04-image-recognition-checklist-v1.md)

## 目标

图片上传成功后立即进行内容理解，把识别摘要作为可追踪的 Agent 上下文。

## 行为要求

- 状态：上传中 → 识别中 → 完成或失败。
- 首期支持图片内容理解和描述，不支持 OCR。
- 完成后展示识别摘要，用户可查看但不可编辑。
- 识别结果写入附件上下文，不替换原始图片。
- 识别失败保留原图，允许用户单独重试。
- 识别失败不阻止用户发送消息。

## 验收标准

- `GC04-AC1`：上传成功自动触发一次识别任务。
- `GC04-AC2`：识别状态可在 UI 和事件中观察。
- `GC04-AC3`：成功摘要只读且进入上下文。
- `GC04-AC4`：失败可重试且不会重复创建无关附件。
- `GC04-AC5`：OCR 不在首期能力声明中。
