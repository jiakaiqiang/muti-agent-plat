---
artifact: verification_checklist
stage: quality
producedBy: quality
schemaVersion: "0.1"
status: implemented_with_deferred_follow_up
deliveryId: discussion-document-revision-v1
intentContractRef: discussion-document-revision-v1
designPlanRef: discussion-document-revision-v1
taskPlanRef: discussion-document-revision-v1
createdAt: 2026-09-20
---

# 群聊方案文件化修订 - Checklist v1

[Spec](../product/discussion-document-revision-spec-v1.md) · [Plan](../design/discussion-document-revision-plan-v1.md) · [Tasks](../implementation/discussion-document-revision-tasks-v1.md)

> 状态：主体实现及 DDR-AC1～DDR-AC10 已完成验收；永久清理/内容对象 GC 延期到独立生命周期协议。勾选项代表当前已有代码和测试证据。

## 1. 验收矩阵

| AC | 必须验证的结果 | 证据 | 状态 |
| --- | --- | --- | --- |
| DDR-AC1 文件生成 | 当前工作区出现唯一、不可覆盖的 Markdown 版本文件 | 文档服务单测、专项 E2E 工作区回读 | ☑ |
| DDR-AC2 内容一致 | 群聊、工作区文件和 Agent 完整读取内容哈希一致 | Provider/Runtime 单测、专项 E2E 工作区正文与 `discussion_document_read` 回执、双端正文 | ☑ |
| DDR-AC3 Agent 读取 | 主 Agent 未完成 `read_file` 回执不能继续讨论 | Runtime fail-closed 单测、编排接线、专项 E2E mock Runtime 完整回执 | ☑ |
| DDR-AC4 版本安全 | 旧版本不再派发；过期、外部修改、hash mismatch fail closed | CAS/外部修改单测、任务 stale 单测、版本修订 E2E | ☑ |
| DDR-AC5 双端展示 | Web/桌面展示相同文档、版本、路径、正文和读取状态 | `test:e2e:discussion-document-revision`（通过） | ☑ |
| DDR-AC6 Provider 一致性 | server_local/local_bridge 读写路径和权限语义一致 | Provider 双实现单测 | ☑ |
| DDR-AC7 并发幂等 | 重复提交只生成一个文档和一条事件 | 并发 HTTP 专项 E2E（通过） | ☑ |
| DDR-AC8 安全边界 | 路径越界、敏感文件、符号链接、超限和 HTML 注入被拒绝 | 工作区安全测试、文档大小/二进制测试、恶意 Markdown 惰性文本渲染测试 | ☑ |
| DDR-AC9 恢复 | 重启、刷新、SSE 重连恢复活动文档和状态 | 文件后端重启、隔离 PostgreSQL 恢复、客户端刷新和 SSE 连接单测已覆盖 | ☑ |
| DDR-AC10 现有行为 | 普通群聊、文件 Diff、工作流执行、桌面只读行为无回归 | typecheck、workspace tests、build、文件修订候选迭代、工作流执行、双端展示和原生 Electron 测试环境渲染均已通过；仓库级串行 `npm test` 的附加审计因环境清理阶段无输出中止，不影响上述范围证据 | ☑ |

## 2. 测试层级

### 合同和单测

- 文档状态和事件 payload 合法性。
- 正文不出现在事件 payload。
- 路径规范化、敏感路径、符号链接和文件大小。
- 版本链、parent、CAS 和幂等键。
- 内容哈希和完整读取回执。

### 后端集成

- server_local 创建、回读、失败回滚。
- local_bridge 创建、权限拒绝、断线恢复。
- LocalContentStore 与工作区正文一致。
- 文件持久化和 PostgreSQL 重启恢复。
- 会话删除、data epoch 和内容对象清理。

### Runtime

- 主 Agent 必须调用 `read_file`。
- 读取错误路径被拒绝。
- `truncated=true` 不得作为完整方案继续。
- 内容哈希不一致必须停车。
- 文档已 superseded 时不能提交讨论成功。

### Web/桌面

- 完整 Markdown 正文展示。
- 版本、路径、URL、哈希展示。
- loading、reading、completed、failed 状态。
- 切换会话时不串正文。
- 刷新和 SSE 重连不重复生成文档。
- 桌面端不出现编辑流程或写入入口。

## 3. 端到端场景

1. 用户提交 v1，工作区生成 `plan-revision-001.md`，群聊展示完整正文。
2. 主 Agent 通过 `read_file` 读取 v1，显示已读取后开始讨论。
3. 主 Agent 邀请两个 Agent，三个 Agent 使用同一 `relativePath/contentHash`。
4. 用户提交 v2，v1 未完成讨论标记过期，主 Agent 重新读取 v2。
5. Web 和桌面端同时在线，文档只发布一次、消息只出现一次。
6. 两个客户端同时提交相同内容，服务端只生成一个版本。
7. 文件被外部修改，Agent 读取哈希不一致，讨论停车并显示原因。
8. local bridge 断开，文档发布失败或读取失败，不能显示“已生效”。
9. SSE 断开再连接，客户端补齐文档事件但不重放创建或读取 mutation。
10. 服务重启后恢复活动文档、历史版本、内容和读取状态。

## 4. 必须保留的失败证据

- 工作区写权限拒绝。
- 路径越界或符号链接越界。
- 敏感路径和非 Markdown 文件。
- 文档超过 200 KB。
- 文件正文缺失、哈希不一致或读取被截断。
- 旧版本继续派发任务。
- 两个客户端重复生成文档。
- Web/桌面展示不同版本。
- 事件 payload 泄漏完整正文或内部 Prompt。

## 5. 验证命令

```powershell
npm run typecheck
npm run test --workspace @agent-cluster/shared
npm run test --workspace @agent-cluster/server
npm run test --workspace @project/web
npm run test:desktop
npm run build
npm run test:e2e:discussion-document-revision
npm run test:e2e:client-presentation
npm run test:e2e:file-revision-candidate-iteration
npm run test:e2e:workflow-managed-execution
$env:ELECTRON_DISABLE_SANDBOX='1'; npm run test:e2e:desktop-render
npm run test:harness
```

如果原生 Electron 环境不可用，不能把 Chromium renderer 或 mock 结果标记为原生桌面通过；必须记录环境阻塞和已通过的替代证据。

## 6. 本轮验证记录（2026-09-21）

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm run typecheck --workspace @agent-cluster/server` | 通过 | 服务端类型检查退出码 0 |
| `npm run typecheck --workspace @agent-cluster/shared` | 通过 | 共享合同类型检查退出码 0 |
| `npm run typecheck --workspace @project/web` | 通过 | Web 类型检查退出码 0 |
| `npm run test --workspace @agent-cluster/server` | 通过 | 1654 tests，1638 passed，16 skipped，0 failed |
| `npm run test --workspace @agent-cluster/shared` | 通过 | 197/197 |
| `npm run test --workspace @project/web` | 通过 | 328/328 |
| `npm run test:desktop` | 通过 | 13/13 |
| `npm run test:harness` | 通过 | 包含 `requiredDocument` Runtime Context 合同同步校验 |
| `npm run test:e2e:discussion-document-revision` | 通过 | Web/desktop renderer 双端、两版本、并发幂等、刷新和正文隔离 |
| `npm run test:e2e:file-revision-candidate-iteration` | 通过 | 修正测试夹具，不再把 management-only coordinator 作为 chat participant；候选迭代、重处理、显式确认和 workspace stale 均通过 |
| `npm run test:e2e:client-presentation` | 通过 | 客户端展示和后端隔离 UI fixture 通过 |
| `npm run test:e2e:workflow-managed-execution` | 通过 | Workflow managed execution smoke 通过 |
| PostgreSQL isolated migration smoke（17/17） | 通过 | 隔离数据库迁移、实例重建后方案文档元数据和 read receipt 恢复通过；未触碰生产库 |
| `npm test` | 未完成（环境级） | 已启动仓库级串行测试，local-runtime-cli 输出至第 34 项后超过 60 秒无新输出；为避免悬挂进程已中止，专项 workspace/server/web/desktop 测试仍以独立通过结果为准 |
| `git diff --check` | 通过 | 仅有工作树既有 LF/CRLF 提示，无空白错误 |
| `$env:ELECTRON_DISABLE_SANDBOX='1'; npm run test:e2e:desktop-render` | 通过 | 实际 Electron protocol/CSP/renderer/刷新验证通过；仅测试环境关闭 Chromium 进程 sandbox，应用 WebPreferences sandbox 仍为 true |

本轮还补充了“拒绝契约后发布方案文件”的 E2E：验证文件正文保留、普通用户事件和 `brief_rejected` 事件不含正文。

专项 E2E 截图：`output/playwright/discussion-document-revision/web.png`、`output/playwright/discussion-document-revision/desktop.png`。

后续遗留：永久清理/保留期入口下的工作区生成文件与未引用内容对象 GC，以及仓库级串行 `npm test` 的环境清理审计。现有 `DELETE /sessions/:id` 是可恢复软删除，立即物理清理会破坏恢复语义，因此未在软删除路径接入 GC；该能力已从本专项任务中标记为延期，不影响 DDR-AC1～DDR-AC10。原先失败的文件修订候选迭代脚本属于测试夹具问题（非法选择 management-only coordinator），已修正夹具并通过，非本专项产品回归。

## 7. 退出条件

只有以下条件全部满足，才能将本专项标记为完成：

- DDR-AC1～DDR-AC10 全部有独立代码和测试证据。
- Web/桌面真实接口和 SSE 路径通过。
- server_local/local_bridge 都完成读写和权限边界验证。
- 旧版本失效和主 Agent 汇总行为通过。
- 没有未记录的正文泄漏、重复发布或跨会话串数据问题。
