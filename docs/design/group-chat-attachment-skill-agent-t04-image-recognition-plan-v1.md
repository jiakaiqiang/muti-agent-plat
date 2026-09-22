# GC-04 图片内容理解与重试 Plan v1

> [Spec](../product/group-chat-attachment-skill-agent-t04-image-recognition-spec-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t04-image-recognition-task-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t04-image-recognition-checklist-v1.md)

## 研究定位

- Runtime/多模态接入：`apps/server/src/modules/runtimes/`。
- 事件流：`apps/server/src/modules/events/`。
- 前端时间线与附件预览：`apps/web/src/components/ChatTimeline.vue`、`apps/web/src/components/UserInputBox.vue`。

## 设计决策

- 识别是附件的派生状态，不修改原始对象。
- Provider 返回的摘要以独立字段保存，不能被用户编辑接口覆盖。
- 识别任务使用稳定附件 ID 幂等；重试增加 attempt，不创建新附件。
- 无多模态 Provider 时明确返回 failed/unsupported，不把 OCR 或文本猜测当作识别结果。
- 默认 Provider 为 fail-closed 的 `UnsupportedImageContentUnderstandingProvider`，部署方可通过 `ImageContentUnderstandingProvider` 注入真实多模态实现。
- `attachment_recognition_started/completed/failed` 事件只携带附件 ID、状态、attempt 和安全摘要/错误码，不携带原始图片字节。

## 实施步骤

1. 定义图片识别 Provider 输入输出和三类状态事件。
2. 在上传成功后设置 `processing` 并异步触发识别任务。
3. 增加成功/失败/重试状态更新，按稳定附件 ID 幂等。
4. 在前端显示状态、只读摘要和失败重试按钮。
5. 增加 fake provider 单测，覆盖成功、失败保留原图和同 ID 重试。

## 风险

- 识别延迟可能超过消息发送；消息必须允许先发送、后补齐摘要。
- Provider 返回空摘要时保持失败或 unknown，不显示虚假完成。
