# GC-03 附件上传、校验与持久化 Task v1

> [Spec](../product/group-chat-attachment-skill-agent-t03-upload-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t03-upload-plan-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t03-upload-checklist-v1.md)

> 状态：已完成（2026-09-22）

## 任务目标

完成附件上传的最小服务端垂直切片：校验 → 保存元数据 → 返回 ID → 失败可重试。

## 10–15 分钟执行清单

1. 建立 `attachments` 服务目录或复用现有文件模块，先确认持久化模式。
2. 实现格式、大小和 4+4 数量的纯校验。
3. 实现上传元数据保存和消息关联，原始对象保存使用现有 provider 边界。
4. 增加失败状态和幂等重试入口。
5. 为消息删除/群聊删除挂接清理回调或事件。
6. 运行服务单测和 API 合同测试。

## 不做

- 不在本任务接入图片识别。
- 不在本任务解析文件内容。
- 不修改 Agent 路由。

## 完成定义

客户端能够拿到稳定附件 ID 和状态，后续 GC-04/GC-05 可以仅依赖该 ID 工作。
