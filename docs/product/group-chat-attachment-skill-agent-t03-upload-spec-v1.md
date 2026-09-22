# GC-03 附件上传、校验与持久化 Spec v1

> 任务：GC-03 | 预计：10–15 分钟 | 前置：GC-01
> [总路线图](../roadmap/group-chat-attachment-skill-agent-sdd-roadmap-v1.md) · [Plan](../../docs/design/group-chat-attachment-skill-agent-t03-upload-plan-v1.md) · [Task](../../docs/implementation/group-chat-attachment-skill-agent-t03-upload-task-v1.md) · [Checklist](../../docs/quality/group-chat-attachment-skill-agent-t03-upload-checklist-v1.md)

## 目标

提供服务端附件上传合同、格式/大小/数量校验、原始文件保存和消息关联。

## 固定规则

- 仅人类用户可上传；Agent 不得主动上传。
- 单条消息最多 4 张图片和 4 个文件。
- 图片 10 MB，文件 50 MB。
- 图片：JPG/JPEG、PNG、GIF、WEBP。
- 文件：PDF、DOC/DOCX、XLS/XLSX、PPT/PPTX、TXT。
- 上传失败可单个重试或删除，不影响其他成功附件。

## 生命周期

- 附件随群聊保存，群聊删除时删除。
- 发送后不可单独删除附件。
- 删除消息时同步删除关联附件。
- 附件引用必须带群聊和消息边界。

## 验收标准

- `GC03-AC1`：合法附件可上传并返回稳定 ID。
- `GC03-AC2`：非法类型、超限大小和超限数量被拒绝。
- `GC03-AC3`：失败附件可独立重试/删除。
- `GC03-AC4`：消息删除和群聊删除能清理附件关联。
- `GC03-AC5`：非上传用户/Agent 不能伪造上传身份。
