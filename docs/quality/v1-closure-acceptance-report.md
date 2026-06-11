# v1 闭环验收报告

验收日期：2026-05-28；浏览器补充验收：2026-05-29

验收结论：带风险可交付。

> 2026-06-11 更新：本报告保留 v1 闭环验收结论。当前工作树已在 v1 之后补充后台执行、队列、恢复、runtime 路由、任务依赖、自动返工、token 预算、记忆确认和工作区 fileChanges 等 v1+ hardening 能力；最新状态以 [v1-acceptance-matrix.md](./v1-acceptance-matrix.md) 和 [feature-inventory-and-status-v1.md](../analysis/feature-inventory-and-status-v1.md) 为准。

本轮验收覆盖文档计划 Step 10 的 P1 项：UX 验收、数据一致性验收、安全验收、发布建议。核心闭环、P1 自动化回归和浏览器人工验收均已通过。

## 1. 验收范围

依据：

- [agent-cluster-prd-v1.md](../product/agent-cluster-prd-v1.md)
- [agent-cluster-system-design-v1.md](../design/agent-cluster-system-design-v1.md)
- [v1-acceptance-matrix.md](./v1-acceptance-matrix.md)
- [v0.1-contract-test-plan.md](../../tests/contracts/v0.1-contract-test-plan.md)

已验证主链：

- 创建会话 -> Agent 讨论 -> 任务契约 -> 用户确认 -> dry-run 执行 -> RAG 检索 -> 复盘 -> 最终交付。
- 执行中用户插话可入库、可生成 handling plan，冲突/约束类消息可暂停到 `WAIT_USER_DECISION`。
- SSE 支持 afterEventId 回补，并覆盖断线后重新连接继续接收新事件。
- 非法状态迁移返回契约错误码 `INVALID_SESSION_TRANSITION` 和 `requestId`。
- 浏览器真实页面已覆盖聊天完成态、任务契约确认、`WAIT_USER_DECISION` 决策卡、协作图、工作流和调试视图。

## 2. UX 验收

| 检查项 | 结论 | 证据 | 风险 |
| --- | --- | --- | --- |
| 用户能在聊天模式下创建任务并继续输入补充消息 | 通过 | `tests/e2e/collaboration-main-chain.spec.ts`, `tests/e2e/p1-behaviors.spec.ts`, `output/playwright/v1-final-chat-completed.png` | 无新增风险 |
| 用户能确认任务契约、暂停/继续/补充 | 通过 | `tests/e2e/collaboration-main-chain.spec.ts`, `tests/e2e/p1-behaviors.spec.ts`, `output/playwright/v1-final-chat-confirmation.png`, `output/playwright/v1-final-wait-user-decision.png` | 决策卡后续可继续打磨，但不阻断 v1 |
| 三种视图能基于同一事件流展示过程 | 通过 | `apps/web/src/stores/event.ts`, `apps/web/src/components/CollaborationGraphView.vue`, `apps/web/src/components/WorkflowRuntimeView.vue`, `output/playwright/v1-final-chat-completed.png`, `output/playwright/v1-final-collaboration-graph.png`, `output/playwright/v1-final-workflow.png` | 可视化视图已支持拖拽缩放，后续可继续补交互回归 |
| RAG 命中来源可见 | 通过 | `tests/e2e/p1-behaviors.spec.ts`, `docs/quality/v1-acceptance-matrix.md` | Agent 卡片和聊天消息展示细节仍可优化 |

UX 结论：核心用户路径可用，满足 v1 闭环演示要求。2026-05-29 已完成浏览器人工 UI checklist：聊天输入、确认卡片、执行中插话决策卡、协作图、工作流阶段事件展示和调试视图。

## 3. 数据一致性验收

| 检查项 | 结论 | 证据 | 风险 |
| --- | --- | --- | --- |
| API 字段保持 camelCase，持久化模型保留 snake_case 边界 | 通过 | `tests/e2e/collaboration-main-chain.spec.ts` | 无新增风险 |
| 用户消息先写事件流，再做路由判断 | 通过 | `tests/e2e/p1-behaviors.spec.ts` | 无新增风险 |
| 任务契约确认后生成任务，并保留确认时间与用户标记 | 通过 | `tests/e2e/collaboration-main-chain.spec.ts` | 无新增风险 |
| RAG 命中可追溯到 knowledge base / document / chunk | 通过 | `tests/e2e/p1-behaviors.spec.ts` | 当前为本地检索实现，真实向量检索接入后需补集成测试 |
| 状态迁移受控，非法迁移不会写入错误状态 | 通过 | `tests/e2e/p1-behaviors.spec.ts` | 后续新增状态时需要同步更新迁移白名单 |

数据一致性结论：v1 闭环的数据事件、状态、RAG 引用链路可追溯，满足带自动化证据的交付条件。

## 4. 安全验收

| 检查项 | 结论 | 证据 | 风险 |
| --- | --- | --- | --- |
| 高风险能力默认需要用户确认 | 通过 | `apps/server/src/modules/capabilities/capabilities.service.ts` | 未接入真实高风险工具前风险较低 |
| 执行中冲突/约束消息会暂停并等待用户决策 | 通过 | `tests/e2e/p1-behaviors.spec.ts`, `output/playwright/v1-final-wait-user-decision.png` | UI 决策操作仍可继续增强 |
| API 错误响应包含稳定 code 和 requestId | 通过 | `tests/e2e/collaboration-main-chain.spec.ts`, `tests/e2e/p1-behaviors.spec.ts` | 无新增风险 |
| RAG 访问按绑定知识库检索 | 通过 | `tests/e2e/p1-behaviors.spec.ts` | v1 未做复杂多用户权限，符合 PRD 后置范围 |
| 前端 API 基础地址来自环境变量 | 通过 | `apps/web/src/api/client.ts` | 无新增风险 |
| API CORS 白名单和基础安全响应头 | 通过 | `tests/e2e/security-smoke.mjs`, `apps/server/src/main.ts` | 后续生产域名需通过 `CORS_ORIGIN` 配置 |

安全结论：v1 的风险边界与 PRD 一致，真实外部工具、真实命令执行、多用户权限属于后置范围。生产化前仍需补认证鉴权和高风险工具端到端确认。

## 5. 自动化验证

已通过：

```text
npm run typecheck --workspaces --if-present
npm run build --workspaces --if-present
npm run lint --workspaces --if-present
npm run test:e2e:main-chain
npm run test:e2e:p1-behaviors
npm run test:e2e:ops
npm run test:e2e:security
npm run test:e2e:real-data-mode
npm run test:e2e:generic-llm-real
npm run test:e2e:postgres-persistence
npm run test:e2e:bullmq-ops
npm run test:e2e:real-agents-no-seed
npm run test:e2e:debug-memory
npm run test:e2e:persistence
```

说明：`test:e2e:p1-behaviors` 覆盖用户执行中插话、RAG 命中、SSE 重连、非法状态迁移。`test:e2e:ops` 覆盖健康检查、队列观测入口和 JSON 结构化日志启动路径。`test:e2e:real-data-mode` 防止生产前端重新引入 mock 数据路径。`test:e2e:generic-llm-real` 覆盖 OpenAI-compatible HTTP runtime 调用。`test:e2e:postgres-persistence` 覆盖 PostgreSQL 跨进程恢复。`test:e2e:bullmq-ops` 覆盖 Redis/BullMQ 真实队列计数。`test:e2e:real-agents-no-seed` 覆盖真实模式 Agent 列表不自动注入默认 seed。`test:e2e:debug-memory` 覆盖 Memory 创建/检索、Context Pack 注入和 Debug API。

浏览器人工验收截图：

- `output/playwright/v1-final-chat-confirmation.png`
- `output/playwright/v1-final-chat-completed.png`
- `output/playwright/v1-final-workflow.png`
- `output/playwright/v1-final-collaboration-graph.png`
- `output/playwright/v1-final-debug.png`
- `output/playwright/v1-final-wait-user-decision.png`

浏览器控制台验收：工作流、协同看板、调试视图和 `WAIT_USER_DECISION` 决策卡检查时均为 0 errors / 0 warnings。

## 6. 发布建议

建议结论：带风险可交付。

可交付理由：

- P0 主链和 P1 行为测试均已有自动化覆盖。
- P1 验收矩阵已全部标记为 `Covered`，且关键项有独立测试证据。
- 浏览器人工验收已完成并保留截图证据。
- 当前 v1 范围以 MockRuntime / dry-run 闭环验证为目标，没有引入真实高风险执行能力。

发布前建议处理：

- 保持 `docs/devops/ci-release-checklist.md` 作为发布前检查入口，后续 CI 接入后同步更新命令和服务依赖。
- 若进入生产环境，配置生产 `CORS_ORIGIN`、补认证鉴权、配置真实日志脱敏。

不建议阻断 v1 演示的问题：

- 真实 Codex/Claude Code Runtime 深度接入。
- 多用户和复杂权限。
- 工作流市场和复杂模板能力。
- 真实外部通知发送。
