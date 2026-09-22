# GC-05 文件按需读取与上下文引用 Task v1

> [Spec](../product/group-chat-attachment-skill-agent-t05-file-context-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t05-file-context-plan-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t05-file-context-checklist-v1.md)

> 状态：已完成（2026-09-22）

## 任务目标

完成文件附件从消息到 Context v2 的索引引用，并提供受权限保护的按需读取入口。

## 10–15 分钟执行清单

1. 在 ContextEnvelope 中挂载文件 ID、文件名、类型、大小和群聊边界。
2. 复用现有文件工具模式实现按 ID 读取。
3. 加入已删除、跨群聊和无权限拒绝分支。
4. 确认普通消息不会默认读取文件二进制。
5. 增加最小集成测试并记录事件/工具输出不泄露正文。

## 已交付

- 消息 ingress、Follow-up 和 Context v2 会携带附件的稳定 ID、文件名、MIME、大小及群聊边界元数据。
- 新增 `read_attachment` 文件工具和 `cap-attachment-read` 能力；工具只接受附件 ID，按权限返回最多 32 KiB 的 Base64 分片。
- 附件正文保持在内容存储中，普通事件和 ContextEnvelope 只保存元数据；Agent 需要时再按 ID 读取。
- 跨 Session、已删除、非文件、未就绪或缺少内容引用的读取均失败关闭；附件引用消息仍支持仅附件发送。
- 增加附件服务、读取工具、Context v2 和消息 ingress 的定向测试，并保持既有 `cap-file-read` 只映射 `read_file`。

## 完成定义

主 Agent 和协同 Agent 能从消息上下文发现文件，并在需要时通过文件 ID 读取；不需要时不会触发解析。
