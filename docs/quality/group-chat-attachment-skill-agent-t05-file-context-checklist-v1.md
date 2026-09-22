# GC-05 文件按需读取与上下文引用 Checklist v1

> [Spec](../product/group-chat-attachment-skill-agent-t05-file-context-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t05-file-context-plan-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t05-file-context-task-v1.md)

## 自动验证

- [x] 文件引用能进入 ContextEnvelope。
- [x] 无文件引用的请求不调用文件工具；正文不会在上下文组装时自动读取。
- [x] 有效文件 ID 可按需读取。
- [x] 跨群聊、无权限和已删除文件读取失败。
- [x] 只发送文件的消息可进入编排，并把附件元数据带入消息链。

## 安全验证

- [x] 二进制正文不进入普通事件日志；事件与 ContextEnvelope 只保存元数据引用。
- [x] 文件读取使用稳定 ID，不接受客户端任意路径。
- [x] 删除后的引用返回可识别的不可用状态。

## 证据记录

| 项目 | 记录 |
| --- | --- |
| 执行日期 | 2026-09-22 |
| 命令 | `npm run typecheck -w @agent-cluster/shared`; `npm run typecheck -w @agent-cluster/server`; `node --import tsx --test apps/server/src/modules/attachments/attachments.service.spec.ts apps/server/src/modules/tools/builtin/attachment-reader.tool.spec.ts apps/server/src/modules/context-v2/build-envelope-from-context-assembly.spec.ts apps/server/src/modules/message-routing/message-ingress.service.spec.ts`; `npm run test -w @agent-cluster/server`; `npm run typecheck -w @project/web`; `npm run test -w @project/web -- src/components/UserInputStop.spec.ts`; `npm run test -w @project/web` |
| 结果 | shared/server/web 类型检查通过；GC-05 定向测试 28/28 通过；Server 全量 1660 通过、17 跳过、0 失败，另有开发服务器 7/7 通过；Web 定向 4/4；Web 全量 66 文件、341 测试通过。 |
| 失败/跳过原因 | 首次 Web 全量回归发现 2 个旧断言仍期待单参数 `send` 事件，已更新为检查结构化事件的第一个参数并重跑通过；Server 的 17 个 skip 为既有测试。 |
