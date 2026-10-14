---
artifact: intent_contract
stage: requirement
producedBy: requirements
schemaVersion: "0.1"
status: implemented_with_deferred_follow_up
deliveryId: session-archive-management-v1
createdAt: 2026-09-21
---

# 会话归档管理 Spec v1

## 1. 目标

在会话列表右侧提供三点操作入口，区分“删除”和“归档”。归档会话从普通列表隐藏，但保留完整会话数据，可在左侧“归档管理”中按项目查看并恢复到会话列表。

## 2. 用户流程

```text
会话三点 -> 归档会话
  -> 关闭执行准入
  -> 等待讨论/执行/Runtime 停止证据
  -> 写入 archivedAt 并释放工作区占用
  -> 普通会话列表隐藏

左侧归档管理 -> 按 projectId 分组 -> 点击恢复
  -> 校验工作区和占用
  -> 清除 archivedAt、恢复会话列表
  -> 会话保持暂停，用户显式继续
```

## 3. 范围与约束

- 删除仍沿用既有可恢复删除墓碑和删除列表，不与归档混用。
- 归档不物理删除事件、任务、产物或讨论记录。
- 运行中的会话不能直接隐藏，必须完成安全停止；停止超时则归档失败并保留原会话。
- 有 `projectId` 时显示“项目 {projectId}”；无项目时优先显示工作区名称，再回退到工作区 ID，最终归入“未归属项目”。
- Web 与桌面共享 API 和数据，样式与壳层保持独立。

## 4. 2026-09-27 变更：归档/删除列表对齐

- 归档管理列表与删除列表使用同样的会话卡片（状态徽标 + 三点菜单）；归档保留按项目分组。
- 归档会话三点菜单提供「恢复归档」和「删除会话」；删除走既有确认流程，删除完成时清除 `archivedAt`，会话进入删除列表。
- 「已删除」列表不再提供恢复入口（后端墓碑与 `/restore` API 保留，仅 UI 入口移除）。
- 归档会话可直接删除，`DELETE /sessions/:sessionId` 不再对归档会话返回 409。
- 归档会话删除卡在 deleting（清理未完成）时仍留在归档列表，此时从归档恢复返回 409。
- 实施记录见 `docs/implementation/session-archive-delete-parity-tasks-v1.md`。
