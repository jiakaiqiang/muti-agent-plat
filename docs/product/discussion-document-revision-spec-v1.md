---
artifact: intent_contract
stage: requirement
producedBy: requirements
schemaVersion: "0.1"
status: implemented_with_deferred_follow_up
deliveryId: discussion-document-revision-v1
createdAt: 2026-09-20
---

# 群聊方案文件化修订 - Spec v1

[设计 Plan](../design/discussion-document-revision-plan-v1.md) · [实施 Tasks](../implementation/discussion-document-revision-tasks-v1.md) · [验收 Checklist](../quality/discussion-document-revision-checklist-v1.md)

## 1. 目标

用户在群聊中修改方案后，系统先把修改后的完整 Markdown 发布为当前工作区内的版本化文件，再让主 Agent 和被邀请 Agent 通过 `read_file` 读取同一个文件版本。群聊同时直接展示该文件的完整 Markdown 内容，最终由主 Agent 汇总讨论结果。

本专项已完成主体实现并进入验收收口。文件版本化、API/事件、双端展示、Runtime 读取强制、旧任务失效和 PostgreSQL 隔离库恢复已有代码与测试证据；原生 Electron 已完成测试环境验证，会话删除后的生成文件/内容对象清理仍未完成，因此不能标记为全部上线完成。

## 2. 已确认决策

1. 方案文件写入当前会话绑定的工作区，而不是只保存在后端内容存储。
2. Agent 使用工作区相对路径调用 `read_file`，不直接读取 `contentRef` 或依赖 HTTP URL。
3. 群聊直接展示完整 Markdown；文档事件只携带引用、版本和哈希，不携带正文。
4. Web 与桌面端共享后端文档和事件状态，但保留各自界面样式和流程管理权限。

## 3. 范围

### 3.1 包含

- 用户方案修订文档的版本化生成。
- 工作区受控目录写入：`.agent-cluster/discussion-documents/<sessionId>/`。
- 文档 URL、相对路径、版本号和 SHA-256 返回。
- 群聊完整 Markdown 展示。
- 主 Agent 强制读取文档后再讨论。
- 其他 Agent 读取相同版本文档。
- 新版本替代旧版本，旧的未完成讨论任务标记为过期。
- Web/桌面 SSE 恢复、刷新和幂等。
- `server_local` 与 `local_bridge` 工作区读取和写入路径一致。

### 3.2 不包含

- 不改变已在执行的 WorkflowRun 的停止或返工语义。
- 不自动修改用户源码文件。
- 不新增通用 URL 读取工具。
- 不把完整正文放入 SSE 事件、普通事件日志或 Prompt。
- 不改变 Agent 全局定义、生命周期和工作流节点语义。
- 不引入用户权限认证体系；沿用当前会话和工作区权限边界。

## 4. 用户流程

```text
用户修改方案
  -> 提交方案文档
  -> 校验工作区写权限与内容大小
  -> 写入不可覆盖的 plan-revision-N.md
  -> 回读并校验 SHA-256
  -> 创建文档产物和当前版本
  -> 发布文档事件
  -> Web/桌面群聊加载并展示完整 Markdown
  -> 主 Agent 调用 read_file
  -> 校验读取回执、版本和哈希
  -> 主 Agent 决定是否邀请其他 Agent
  -> 其他 Agent 读取同一版本
  -> 主 Agent 汇总并回复用户
```

写入、回读或校验失败时，不发布“已生效”事件，不派发讨论任务，并在群聊中显示可操作的错误原因。

现有“修改任务契约”编辑器会预填完整契约的 Markdown 草稿；用户提交后该正文只写入版本化方案文件。普通 `user_message`、`brief_rejected`、Session Memory 和 Agent Prompt 只保留文档路径、版本、文档 ID 与哈希，Agent 必须通过 `read_file` 获取正文。

## 5. 文档版本语义

每次提交生成新版本，不覆盖旧文件：

```text
v1 active
  -> 用户修改
v2 published/active
  -> v1 superseded
```

旧版本的历史消息和文件保留。旧版本未开始或未完成的讨论任务不得继续创建新任务；已执行的工作流不被本专项静默中断。

## 6. 用户可见信息

群聊必须展示：

- 方案标题。
- 方案版本。
- 工作区相对路径。
- 可复制的文档 URL。
- 内容哈希。
- 完整 Markdown 正文。
- 主 Agent 的读取状态。
- 读取失败、版本过期或权限不足的明确原因。

## 7. 验收条件

- **DDR-AC1 文件生成**：用户提交后，工作区存在唯一的 UTF-8 Markdown 文件，不能覆盖旧版本。
- **DDR-AC2 内容一致**：群聊展示正文、工作区文件正文和 Agent 完整读取正文三者哈希一致。
- **DDR-AC3 Agent 读取**：主 Agent 未产生完整 `read_file` 回执前不能开始方案讨论或邀请其他 Agent。
- **DDR-AC4 版本安全**：新版本发布后，旧版本未完成讨论不能继续派发；错误版本、哈希不一致或外部修改必须 fail closed。
- **DDR-AC5 双端展示**：Web 和桌面端在同一会话中展示同一文档 ID、版本、路径和正文；刷新及 SSE 重连不重复生成。
- **DDR-AC6 Provider 一致性**：`server_local` 和 `local_bridge` 均通过 WorkspaceProvider 完成受控写入和 `read_file` 读取。
- **DDR-AC7 并发幂等**：同一内容的重复提交只生成一个文档和一条发布事件；不同内容按版本 CAS 顺序生成。
- **DDR-AC8 安全边界**：禁止路径越界、敏感路径、符号链接越界、超限内容和未经消毒的 HTML 注入。
- **DDR-AC9 恢复**：服务重启、客户端刷新、SSE 重连后能够恢复当前活动文档和读取状态。
- **DDR-AC10 现有行为保持**：普通群聊、已有产物、文件 Diff、工作流执行和桌面只读流程管理不发生非目标变化。

## 8. 风险和限制

- 当前 `read_file` 的不同 Provider 路由能力需要统一，否则 `local_bridge` 可能没有服务端本地根路径。
- 文档上限按现有文件修订上限暂定 200 KB；超限拒绝发布，不静默截断。
- Markdown 直接展示必须避免使用未经消毒的 `v-html`。
- 工作区写入权限被拒绝时，需要复用现有权限确认和失败提示机制。
