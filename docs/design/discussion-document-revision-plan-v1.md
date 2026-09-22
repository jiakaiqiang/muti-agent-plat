---
artifact: design_plan
stage: design
producedBy: design
schemaVersion: "0.1"
status: implemented_with_deferred_follow_up
deliveryId: discussion-document-revision-v1
intentContractRef: discussion-document-revision-v1
createdAt: 2026-09-20
---

# 群聊方案文件化修订 - Design Plan v1

[Spec](../product/discussion-document-revision-spec-v1.md) · [Tasks](../implementation/discussion-document-revision-tasks-v1.md) · [Checklist](../quality/discussion-document-revision-checklist-v1.md)

## 1. 设计结论

新增会话级 `DiscussionDocument` 领域对象和文档服务。文档正文同时保存到 `LocalContentStore` 与当前工作区受控目录；数据库或文件持久化只保存元数据、内容引用和哈希。发布事件只携带文档引用，Web/桌面按引用拉取正文并展示。Agent 通过统一的 `WorkspaceProvider` 读取工作区路径，服务端验证完整读取和哈希后才允许编排继续。

不把此功能硬塞进现有 `FileRevisionsService`：文件修订服务的输入是已有工作区文件的基线/候选链，而本功能的输入是群聊中用户提交的方案正文。两者共享内容存储、哈希、工作区安全和状态版本模式，但领域生命周期分开。

## 2. 当前实现依据

- `apps/server/src/modules/file-revisions/file-revisions.service.ts` 已有不可变内容引用、版本链和哈希校验模式。
- `apps/server/src/modules/persistence/local-content-store.ts` 已有内容寻址存储和完整性校验。
- `apps/server/src/modules/workspaces/workspace-provider.ts` 定义了 `readFile/applyChangeSet`，可统一 `server_local/local_bridge`。
- `apps/server/src/modules/runtimes/workspace-tools.service.ts` 当前按 `rootPath` 读取，需改为 Provider 路由或新增受控 Provider Reader。
- `apps/server/src/modules/artifacts/artifacts.service.ts` 已有会话产物元数据，但不提供方案正文工作区写入和版本状态。
- `apps/web/src/components/ChatTimeline.vue` 已有文档型消息、报告和结构化卡片展示，可新增独立方案文档消息组件。
- `apps/web/src/stores/event.ts` 和桌面 renderer 各自投影 SSE 事件，必须共同增加文档事件投影。

## 3. 领域模型

```ts
type DiscussionDocument = {
  id: UUID
  sessionId: UUID
  workItemId?: UUID
  parentDocumentId?: UUID
  revision: number
  title: string
  relativePath: string
  contentRef: string
  contentHash: string
  sizeBytes: number
  status: 'published' | 'active' | 'superseded' | 'failed'
  createdBy: 'user' | 'main_agent' | 'system'
  workspaceRevision?: WorkspaceRevision
  createdAt: ISODateTime
  updatedAt: ISODateTime
}
```

文档正文不进入领域事件和普通日志；正文通过 `contentRef` 和工作区文件保留。`relativePath` 必须是规范化的工作区相对路径。

## 4. 工作区写入设计

### 4.1 路径

```text
.agent-cluster/discussion-documents/<sessionId>/plan-revision-<revision>.md
```

在共享工作区忽略/索引规则中将 `.agent-cluster` 识别为生成目录，但显式 `read_file` 和文档 URL 仍可访问。

### 4.2 写入顺序

```text
校验内容和路径
  -> LocalContentStore.put
  -> WorkspaceProvider.applyChangeSet(create)
  -> WorkspaceProvider.readFile 回读
  -> 比较完整 SHA-256
  -> 持久化 DiscussionDocument
  -> 发布 discussion_document_published
```

任何一步失败都不产生 `active` 文档。`local_bridge` 的 `workspace_write` 权限沿用现有权限策略；拒绝时返回可见权限状态，不绕过授权。

### 4.3 原子性和幂等

幂等键为：

```text
sessionId + parentDocumentId + contentHash + clientMessageId
```

创建过程使用会话级活动版本 CAS。同一内容的并发请求返回同一个文档；不同内容按先提交成功者递增版本，失败方重新读取当前活动版本。

## 5. API 和事件

### 5.1 API

```text
POST /api/sessions/:sessionId/discussion-documents
GET  /api/sessions/:sessionId/discussion-documents
GET  /api/sessions/:sessionId/discussion-documents/active
GET  /api/sessions/:sessionId/discussion-documents/:documentId
GET  /api/sessions/:sessionId/discussion-documents/:documentId/content
```

正文响应使用 `text/markdown; charset=utf-8`、`Cache-Control: no-store` 和哈希 ETag。API 只返回当前会话拥有的文档。

### 5.2 发布事件

新增 `discussion_document_published`，payload 仅包含：

```ts
{
  documentId: UUID
  artifactId: UUID
  documentRole: 'discussion_plan'
  revision: number
  parentDocumentId?: UUID
  title: string
  relativePath: string
  contentUrl: string
  contentHash: string
  sizeBytes: number
}
```

可新增内部/公开投影事件 `discussion_document_read`，只携带 `documentId/agentId/contentHash/complete/readAt`。正文、Prompt、绝对路径和 provider 原始错误不得进入事件。

## 6. Agent 读取设计

主 Agent 的 invocation context 增加：

```ts
requiredDocument: {
  documentId: UUID
  revision: number
  relativePath: string
  contentHash: string
}
```

Runtime 的 `read_file` 通过 `WorkspaceProviderResolver` 路由，不再只依赖服务端 `rootPath`。服务端对工具审计记录进行后置校验：必须读取精确路径、完整内容、非截断、哈希匹配且文档仍是活动版本。没有有效回执的结果进入 `DOCUMENT_READ_REQUIRED`，不进入 Agent 讨论成功分支。

现有共享 `ReadFileInput` 已支持 `startLine/endLine/maxBytes`，实现应保留分段读取能力。方案文档首期超过 200 KB 直接拒绝，避免把截断正文当成完整需求。

## 7. 前端展示设计

新增 `DiscussionDocumentMessage`，消息内容由事件引用触发 API 拉取：

- 标题、版本、路径、复制地址、哈希。
- 默认展开完整 Markdown 原文。
- 显示“主 Agent 正在读取/已读取/读取失败”。
- 内容加载采用 `generation` 防止切换会话后的迟到响应串入。
- 不使用未经消毒的 `v-html`；第一版可使用保留 Markdown 原文的安全 `<pre>`，后续如需富渲染再引入受控 Markdown parser。
- Web 和桌面分别维护样式，但共享 payload 和状态语义。

## 8. 版本和任务语义

发布新文档时：

1. 旧活动文档改为 `superseded`。
2. 绑定旧文档且未开始的讨论任务改为 `superseded`。
3. 已完成旧结果保留 `basedOnDocumentId` 和 `stale=true`。
4. 已执行 WorkflowRun 不由本专项自动停止；继续使用现有停止/变更控制。
5. 主 Agent 必须基于新文档重新判断 Agent 协作并汇总。

## 9. 持久化

文件持久化增加 `discussionDocuments` 集合；PostgreSQL 增加 `discussion_documents` 表和 `content_objects` 关联。当前会话删除仍遵循可恢复软删除语义，因此本专项不在 `DELETE /sessions/:id` 入口物理删除文档文件或内容对象。永久删除/保留期清理需要后续单独的生命周期协议；历史会话恢复必须先校验 data epoch 和内容哈希。

## 10. 安全与失败关闭

- 所有路径使用 `normalizeRelativePath + safeJoin + assertWithinRootRealpath`。
- 禁止敏感路径和符号链接越界。
- 只有 Markdown/UTF-8 文本可发布。
- 工作区写权限拒绝、文件回读失败、哈希不一致、版本过期、Provider 断线均停止编排。
- 文档正文不进入日志和 SSE payload。
- API 只允许会话范围内读取；后续接入用户认证时沿用同一资源边界。

## 11. 允许和禁止修改范围

允许：

- `packages/shared/src/contracts.ts`、事件合同和相关测试。
- `apps/server/src/modules/discussion-documents/`、sessions/events/runtimes/workspaces/persistence 的必要接线。
- `apps/web/src/types`、stores、ChatTimeline 和文档消息组件/样式。
- `apps/desktop/renderer` 对应的独立消息展示接线。
- 专项单测、集成测试、双端 E2E 和本四件套文档。

禁止：

- 修改已有 WorkflowRun 执行语义以绕过用户停止或质量门。
- 将文档正文写入事件日志、Prompt 或全局 Agent 配置。
- 桌面端新增流程编辑入口。
- 用本地乐观事件替代后端发布和读取回执。
