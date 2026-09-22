# GC-04 图片内容理解与重试 Checklist v1

> [Spec](../product/group-chat-attachment-skill-agent-t04-image-recognition-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t04-image-recognition-plan-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t04-image-recognition-task-v1.md)

## 自动验证

- [x] 上传成功会创建一次图片识别任务，并先进入 `processing`。
- [x] fake provider 成功时保存摘要和 `ready` 状态。
- [x] provider 失败时保存 `failed` 状态并保留原图。
- [x] 重试复用原附件 ID，不产生重复附件。
- [x] 识别摘要只由 Provider 成功路径写入；不存在普通编辑接口覆盖摘要。

## 手工验证

- [x] UI 显示“识别中”。
- [x] 成功后显示摘要且不可编辑。
- [x] 失败后有重试入口，仍可发送消息。
- [x] UI 没有把 OCR 作为首期能力展示。

## 证据记录

| 项目 | 记录 |
| --- | --- |
| 执行日期 | 2026-09-22 |
| 命令 | `npm run typecheck -w @agent-cluster/server`; `node --import tsx --test apps/server/src/modules/attachments/attachments.service.spec.ts`; `npm run test -w @agent-cluster/server`; `npm run typecheck -w @project/web`; `npm run test -w @project/web -- src/components/UserInputBoxComposer.spec.ts`; `npm run test -w @project/web` |
| 结果 | Server 类型检查通过；识别/上传定向测试 8/8 通过；Server 全量 1654 通过、17 跳过、0 失败；Web 类型检查通过；Composer 10/10 通过；Web 全量 66 文件、341 测试通过 |
| 失败/跳过原因 | 首次并行测试因 Windows `spawn EPERM` 被环境拒绝，串行受控权限重跑通过；Server 全量 17 个既有 skip 与本任务无关。 |
