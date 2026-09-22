# GC-03 附件上传、校验与持久化 Checklist v1

> [Spec](../product/group-chat-attachment-skill-agent-t03-upload-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t03-upload-plan-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t03-upload-task-v1.md)

## 自动验证

- [x] 合法图片/文件上传返回稳定 ID，并将原始字节保存到 `LocalContentStore`。
- [x] 非支持格式被拒绝并保留单附件 `failed` 状态。
- [x] 图片超过 10 MB、文件超过 50 MB 被拒绝。
- [x] 第 5 张图片或第 5 个文件被拒绝，失败附件不阻塞其他成功附件。
- [x] 上传失败可以按稳定 ID 单独重试，成功附件不受影响。
- [x] 服务提供消息删除和群聊删除的幂等附件清理接口。

## 安全验证

- [x] Agent 身份不能调用用户上传入口（`x-agent-id`/非 user actor guard）。
- [x] 附件 ID 跨群聊访问被拒绝。
- [x] 失败状态不会被伪造为 ready；仅成功保存后返回 `ready`。

## 证据记录

| 项目 | 记录 |
| --- | --- |
| 执行日期 | 2026-09-22 |
| 命令 | `npm run typecheck -w @agent-cluster/server`; `node --import tsx --test apps/server/src/modules/attachments/attachments.service.spec.ts`; `npm run test -w @agent-cluster/server`; `npm run typecheck -w @project/web`; `npm run test -w @project/web -- src/api/client.spec.ts` |
| 结果 | Server 类型检查通过；附件定向测试 6/6 通过；Server 全量 1652 通过、17 跳过、0 失败；Web 类型检查通过；multipart client 测试 6/6 通过 |
| 失败/跳过原因 | Server 全量测试中的 17 个既有 skip 与本任务无关；无本任务断言失败。 |
