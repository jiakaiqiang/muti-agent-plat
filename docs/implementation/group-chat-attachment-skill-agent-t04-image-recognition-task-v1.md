# GC-04 图片内容理解与重试 Task v1

> [Spec](../product/group-chat-attachment-skill-agent-t04-image-recognition-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t04-image-recognition-plan-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t04-image-recognition-checklist-v1.md)

> 状态：已完成（2026-09-22）

## 任务目标

把上传成功的图片接入一个可观察、可重试的内容理解流程，首期明确排除 OCR。

## 10–15 分钟执行清单

1. 为图片附件补充识别状态、摘要、attempt 和失败原因字段。
2. 在上传成功后将图片置为 `processing` 并异步触发一次 Provider 任务。
3. 使用可替换的图片内容理解 Provider；未配置多模态能力时返回 `unsupported` 失败。
4. 保存成功/失败状态，重试复用同一附件 ID，不复制原始内容。
5. 在附件预览中显示识别中、只读摘要和失败重试入口；识别事件进入群聊事件流。
6. 增加 fake provider 服务测试和 Composer 组件测试。

## 不做

- 不增加 OCR。
- 不允许用户编辑识别摘要。
- 不阻塞附件消息发送。

## 完成定义

用户能看到识别状态和只读摘要，Agent 能通过附件上下文读取摘要，失败时可以重试。
