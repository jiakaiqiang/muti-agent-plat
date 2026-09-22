# GC-05 文件按需读取与上下文引用 Plan v1

> [Spec](../product/group-chat-attachment-skill-agent-t05-file-context-spec-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t05-file-context-task-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t05-file-context-checklist-v1.md)

## 研究定位

- Context v2 入口：`apps/server/src/modules/context-v2/`。
- 文件/工作区读取：`apps/server/src/modules/workspaces/`、现有 Tool Authority。
- 编排入口：`apps/server/src/modules/orchestrator/`。

## 设计决策

- 采用附件索引先行、文件工具按需取证的模式。
- ContextPack 只注入文件索引和权限范围，不注入完整二进制。
- 文件工具 `read_attachment` 使用稳定附件 ID，返回受 Session 边界保护的最多 32 KiB Base64 分片；能力注册为 `cap-attachment-read`，不改变既有 `cap-file-read -> read_file` 映射。
- 删除附件后，旧消息中的引用变为不可读取并记录明确错误。

## 实施步骤

1. 把附件元数据映射到消息 ContextEnvelope、L1 invocation 和 Follow-up。
2. 增加按附件 ID 读取的 `read_attachment` 工具，并接入 Generic Runtime 的工具循环。
3. 校验 Session/群聊边界、附件类型、状态、内容引用和 Agent 能力授权。
4. 增加无引用不读取、有效引用读取、删除/跨 Session 拒绝三组测试。
5. 运行 shared/server/web 类型检查、定向测试和全量回归，完成串行门禁记录。

## 风险

- 大文件读取可能超出模型上下文；工具应保留分页/截断边界供后续扩展。
- 二进制读取结果不得写入普通事件日志。
- 当前返回 Base64 分片，后续可在相同稳定 ID 合同上增加分页游标或按文件类型解析器。
