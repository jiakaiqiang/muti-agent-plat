---
artifact: design_plan
stage: design
producedBy: design
schemaVersion: "0.1"
status: implemented_with_deferred_follow_up
deliveryId: session-archive-management-v1
createdAt: 2026-09-21
---

# 会话归档管理 Design Plan v1

## 1. 数据模型

在已有 `SessionDetail`/`SessionListItem` 增加可选 `archivedAt`。不扩展删除生命周期状态，避免破坏现有 PostgreSQL `session_lifecycles` 约束；归档状态属于会话投影字段并随 `sessions` collection 持久化。

## 2. 服务端

- `GET /sessions?visibility=archived`：返回归档会话投影。
- `GET /sessions/archives`：按 `projectId`（无则工作区名称、workspace ID 或未归属）分组。
- `POST /sessions/:sessionId/archive`：安全停止后归档。
- `POST /sessions/:sessionId/archive/restore`：校验工作区后恢复，保持暂停。
- `SessionLifecycleStore.markArchived/restoreArchived` 复用停止证据和事件审计，不改变 delete/restore 语义。

## 3. 前端

`SessionSidebar` 增加“归档管理”页签、项目分组、恢复按钮；普通会话行显示三点按钮，点击后出现收藏、归档、删除。Web/desktop 复用合同和 Pinia 数据，但保留各自样式文件。

## 4. 并发与安全

- 归档前关闭 admission，所有新执行入口被现有生命周期准入拦截。
- 停止证据不完整时 fail closed，不设置 `archivedAt`。
- 恢复先获取工作区 lease，失败不改变归档状态。
- `archivedAt` 仅是状态，不触发内容对象 GC 或历史记录删除。
