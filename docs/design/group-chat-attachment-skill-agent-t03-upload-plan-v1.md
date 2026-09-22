# GC-03 附件上传、校验与持久化 Plan v1

> [Spec](../product/group-chat-attachment-skill-agent-t03-upload-spec-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t03-upload-task-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t03-upload-checklist-v1.md)

## 研究定位

- 后端模块入口：`apps/server/src/modules/`，优先复用 sessions、persistence 和 events 的边界。
- 前端 API：`apps/web/src/api/client.ts`。
- 共享合同：`packages/shared/src/contracts.ts`。
- 群聊/消息删除：复用现有会话和持久化事务，不在上传模块自行删除会话。

## 设计决策

- 新增附件领域服务，原始对象存储与元数据分离。
- 校验在服务端最终执行，客户端提示不能替代权限校验。
- 上传状态通过事件或消息状态回写，允许失败附件单独重试。
- 删除采用幂等操作，先删除可引用状态，再清理对象。

## 实施步骤

1. 增加上传请求/响应和校验函数。
2. 增加附件元数据持久化与消息关联。
3. 增加上传失败、重试、消息删除和群聊删除的服务边界。
4. 在 API client 增加最小调用封装。
5. 增加服务单测和非法输入测试。

## 风险

- 外部对象存储不可用时不能伪造 ready 状态。
- 大文件不应进入事件正文，事件只传 ID、元数据和状态。
- 删除关联需要防止跨群聊 ID 访问。
