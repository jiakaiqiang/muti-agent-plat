---
artifact: task_plan
stage: implementation
producedBy: implementation
schemaVersion: "0.1"
status: implemented_with_deferred_follow_up
deliveryId: discussion-document-revision-v1
intentContractRef: discussion-document-revision-v1
designPlanRef: discussion-document-revision-v1
createdAt: 2026-09-20
---

# 群聊方案文件化修订 - Tasks v1

[Spec](../product/discussion-document-revision-spec-v1.md) · [Plan](../design/discussion-document-revision-plan-v1.md) · [Checklist](../quality/discussion-document-revision-checklist-v1.md)

> 状态：主体实现及 DDR-AC1～DDR-AC10 验收已完成；永久清理/内容对象 GC 已延期到独立生命周期协议。以下仅保留代码和测试证据，延期项用 `[—]` 标记。

## 1. 实施顺序

```text
DDR-T1 合同
  -> DDR-T2 文档领域和持久化
  -> DDR-T3 工作区写入
  -> DDR-T4 API/事件
  -> DDR-T5 Runtime read_file 与读取回执
  -> DDR-T6 Web 展示
  -> DDR-T7 桌面展示
  -> DDR-T8 版本失效与主 Agent 编排
  -> DDR-T9 测试和恢复
  -> DDR-T10 文档同步与交付
```

## 2. 任务清单

### DDR-T1 共享合同和事件

- [x] 增加 `DiscussionDocument`、`DocumentReadReceipt`、事件 payload 和文档状态类型。
- [x] 增加 `discussion_document_published` 和 `discussion_document_read` 合同。
- [x] 扩展 Web/桌面合同投影，禁止正文进入事件 payload。
- [x] 补充共享合同单测和非法 payload 测试。

允许路径：`packages/shared/src/`、`apps/web/src/types/`、`apps/desktop/renderer/` 类型文件。

### DDR-T2 文档领域服务和持久化

- [x] 新增 `apps/server/src/modules/discussion-documents/`。
- [x] 实现版本链、活动 head、parent、content hash、状态和幂等键。
- [x] 接入 `LocalContentStore`，正文和元数据分离保存。
- [x] 接入文件持久化和 PostgreSQL 状态写入/恢复代码；隔离 PostgreSQL 数据库已验证文档元数据和 `readReceipts` 跨实例恢复。
- [x] 增加 data epoch 隔离测试；旧 epoch 文档不会在恢复后继续暴露为 active。
- [—] 永久清理、内容对象 GC 延期到独立生命周期协议；当前会话删除为可恢复软删除，本专项不在该入口物理清理。

必须保证同一会话同一 parent/content hash 只有一个文档。

### DDR-T3 当前工作区文件写入

- [x] 生成 `.agent-cluster/discussion-documents/<sessionId>/plan-revision-N.md`。
- [x] 使用 WorkspaceProvider 的 `applyChangeSet(create)` 写入，不覆盖已有版本。
- [x] 写入后通过 Provider 回读并校验完整哈希。
- [x] 处理 `server_local` 和 `local_bridge` 的权限、断线、越界和符号链接失败。
- [x] 更新生成目录识别，避免普通索引被方案文件污染，同时保留显式读取。

不得直接使用绝对路径或绕过 WorkspaceProvider 写文件。

### DDR-T4 API 和事件发布

- [x] 实现创建、列表、活动版本、元数据和 Markdown 内容 API。
- [x] 返回 `relativePath/contentUrl/uiUrl/revision/contentHash`。
- [x] 设置 `text/markdown`、`no-store` 和 ETag。
- [x] 创建成功后发布一次 `discussion_document_published`。
- [x] API 输入使用会话级资源校验和 Idempotency-Key。

### DDR-T5 Runtime 读取和回执

- [x] 将 `read_file` 从服务端 rootPath 读取统一到 WorkspaceProvider。
- [x] 支持 server_local/local_bridge 的相同输入合同。
- [x] 在 invocation context 注入 required document 引用。
- [x] 记录精确路径、完整性、哈希和 workspace revision 的 read receipt。
- [x] 未读取、读取截断、哈希不一致或版本过期时 fail closed。
- [x] 保留分段读取字段，禁止把分段结果误认为完整文件。

### DDR-T6 Web 群聊展示

- [x] 新增方案文档消息类型和方案文档消息展示。
- [x] 根据 contentUrl 拉取完整 Markdown，默认展开显示。
- [x] 展示标题、版本、路径、URL、哈希和 Agent 读取状态。
- [x] 按 session/document generation 防止迟到响应串会话。
- [x] 失败、超限和过期状态使用可访问提示。
- [x] 不使用未经消毒的 HTML 渲染。

### DDR-T7 桌面群聊展示

- [x] 在桌面 renderer 接入同一事件和文档 API。
- [x] 保持桌面独立样式和只读流程管理边界。
- [x] 支持刷新、SSE 重连和内容错误展示。
- [x] 不在桌面新增工作流编辑或文档写入入口。

### DDR-T8 版本失效和主 Agent 汇总

- [x] 新版本发布时将旧活动文档标记 `superseded`。
- [x] 旧文档未完成讨论任务停止后续派发并记录 stale 依据。
- [x] 主 Agent 必须以新 documentId/revision 重新读取和规划。
- [x] 被邀请 Agent 使用相同文档引用，最终结果由主 Agent 汇总。
- [x] 不自动停止已执行 WorkflowRun，沿用现有控制路径。

### DDR-T9 测试和恢复

- [x] 服务单测：路径、哈希、版本链、幂等、CAS、失败回滚。
- [x] Provider 集成：server_local/local_bridge 读写一致。
- [x] Runtime 单测：强制 read receipt、截断和 hash mismatch fail closed。
- [x] Web/桌面组件测试：正文、版本、地址、读取状态和错误。
- [x] 双端 E2E：提交、展示、读取、刷新、并发和唯一事件；专项 Chromium 双端冒烟已通过，并覆盖“拒绝契约后发布方案文件”和普通事件正文隔离。
- [x] 相关文件修订候选迭代和 Workflow managed execution 回归通过；修正了测试夹具中将 management-only coordinator 误列为 chat participant 的问题。
- [x] 文件持久化重启后恢复活动文档、正文和读取回执。
- [x] PostgreSQL 隔离数据库重启/重建后恢复方案文档元数据和读取回执。
- [x] 不调用真实模型；使用 mock runtime 和隔离工作区。

### DDR-T10 文档同步和交付

- [x] 更新 API、事件、Runtime、UI 状态合同索引。
- [x] 更新 `docs/README.md` 的专题入口。
- [x] 记录实际测试命令、退出码、截图和未通过环境项。
- [x] 未满足 DDR-AC1～AC10 前不把本专项标记为完成。

## 3. 预期验证命令

```powershell
npm run typecheck
npm run test --workspace @agent-cluster/shared
npm run test --workspace @agent-cluster/server
npm run test --workspace @project/web
npm run test:desktop
npm run build
npm run test:e2e:discussion-document-revision
npm run test:e2e:client-presentation
npm run test:harness
```

真实模型、生产数据库和部署不属于本专项验证范围。
