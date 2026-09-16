---
artifact: implementation_summary
stage: implementation
producedBy: frontend
schemaVersion: "0.1"
status: ready            # draft | ready
deliveryId: workflow-view-agent-chain-v1
createdAt: 2026-08-11T18:00:00+08:00
completedAt: 2026-08-23T14:05:00+08:00
taskPlanRef: docs/design/workflow-view-agent-chain-system-design-v1.md
---

# Implementation Summary: 工作流视图 Agent 链改造

> 上游需求：[`../product/workflow-view-agent-chain-requirements-v1.md`](../product/workflow-view-agent-chain-requirements-v1.md)
> 上游设计与任务计划：[`../design/workflow-view-agent-chain-system-design-v1.md`](../design/workflow-view-agent-chain-system-design-v1.md)

T0–T4 已全部完成并通过验证。下方每条结论都对应一次真实的命令输出或代码检查，未通过自动化断言覆盖的条目在证据列明确标注为「代码检查」。

## 1. 任务完成状态

| 任务 | 负责范围 | 状态 | 说明 |
| --- | --- | --- | --- |
| T0 | 群聊基线快照 | 已完成 | 7/7 通过，先于所有视图改动落地 |
| T1 | 右侧面板名称解析与心跳折叠 | 已完成 | 7/7 通过；改动前对旧组件先失败 5/7 |
| T2 | `workflowChainModel.ts` 纯函数模型 | 已完成 | 22/22 通过，测试先行 |
| T3 | 画布瘦身、三态、脉冲边 | 已完成 | `vue-tsc` 干净，216 项全绿 |
| T4 | 详情面板、讨论区、文案门禁 | 已完成 | 含 `project-map.md` 同步 |

## 2. 变更文件

| 任务 | 文件 | 变更类型 |
| --- | --- | --- |
| 前置 | `package.json` | 修改（接入 `test:harness:workflow-view-docs` 门禁） |
| 前置 | `docs/ai-agent-context/project-map.md` | 修改（前端地图指向链路模型；文档地图登记三份交付文档） |
| 前置 | `tests/harness-engineering/workflow-view-agent-chain-documentation.spec.mjs` | 新增（文档门禁 16 项） |
| T0 | `apps/web/src/components/ChatSurfaceBaseline.spec.ts` | 新增 |
| T1 | `apps/web/src/components/CollaborationLogPanel.vue` | 修改 |
| T1 | `apps/web/src/components/CollaborationLogPanel.spec.ts` | 新增 |
| T2 | `apps/web/src/components/workflowChainModel.ts` | 新增 |
| T2 | `apps/web/src/components/workflowChainModel.spec.ts` | 新增 |
| T3 | `apps/web/src/components/WorkflowRuntimeView.vue` | 修改（画布重写） |
| T3 | `apps/web/src/styles.css` | 修改（三态 token、脉冲动画、删除死规则） |
| T4 | `apps/web/src/components/WorkflowAgentInspector.vue` | 新增 |
| T4 | `apps/web/src/components/WorkflowRuntimeView.vue` | 修改（接入详情面板与讨论区） |
| T4 | `tests/e2e/chinese-visible-copy-smoke.mjs` | 修改（纳入两个新组件） |

## 3. 范围偏差

无。所有改动均落在 Task Plan 的 `allowedPaths` 合集内。

补充说明：工作树中另有 `SessionWorkspace.vue`、`stores/localRuntime.ts`、`stores/session.ts`、`types/contracts.ts`、`utils/localRuntimeLauncher.ts`、`views/LocalRuntimeManagerView.vue` 等文件显示为已修改，这些是本次任务开始前就存在的改动，本次会话未编辑其中任何一个。

## 4. 关键实现决策

### 4.1 名称解析改走 `resolveActor()`

`CollaborationLogPanel.vue` 原来只在 `props.agents`（会话参与者卡片）里查名。接收者这类系统 Agent 的 `allowedSurfaces` 只有 `management`，永远不在参与者名单，于是回退成 UUID 原文。改用 `resolveActor()` 后走 `agentStore`，`mergeWithDefaultAgents()` 已兜底注入系统 Agent，名称可解析。

### 4.2 心跳折叠是必需项而非优化项

右侧面板窗口为 8 条。`orchestrator.service.ts` 每 30 秒发一条 `RUNTIME_HEARTBEAT`，一次 5 分钟的模型调用产生 10 条，把全部真实执行事件挤出窗口——这正是「看不到具体执行 Agent」的直接成因。折叠规则：同一 `runtimeInvocationId` 的**连续**心跳合并为一条并显示最大 `elapsedMs`；被真实事件打断的心跳不跨越合并。

### 4.3 讨论分组必须以 `round` 为主判据

`orchestrator.service.ts` 发出讨论 `agent_message` 时只带 `round`/`messageKind`/`mentionedAgentIds`，**不带 `phase`**。原 `intake` 阶段过滤器要求 `phase ∈ {requirement_intake, workspace_analysis, discussion}`，导致讨论消息一律被过滤掉。`discussionRounds()` 以 `round` 为主判据，`phase` 仅作补充，并有专门测试覆盖「`phase` 缺失、仅有 `round`」的情况。

### 4.4 `fallback` 边保留布局但排除脉冲

原实现会为每个未连通节点补一条从链首出发的边，避免孤立节点无连接。这些边是布局兜底、不代表真实流转。若不排除，pending 节点会因一条假边显示脉冲，误导用户以为有数据在流动。因此保留边（否则画布散乱）但排除在脉冲判定外，并用虚线弱化。

### 4.5 一处会让改造整体失效的 CSS 优先级问题

模板一度同时挂 `workflow-node` 与 `workflow-chain-node` 两个类，而旧规则 `.mode-workflow .workflow-node` 的 `min-height: 150px` 在 CSS 中会压过新规则的 `max-height: 76px`（min-height 优先级更高）。若不处理，节点会长回改造前那种竖排文字柱，本次需求的核心问题原地复现。已删除旧类引用与全部死规则（`.workflow-node`、`.workflow-agent-node.*`、`.workflow-node-1..5`、`.workflow-output`、`.workflow-hub`、`.workflow-arrow`、`.arrow-1..5`）。

## 5. 自检

- [x] 未修改 `apps/server/**`
- [x] 未修改 `packages/shared/**`
- [x] 未修改 `apps/web/src/stores/event.ts`
- [x] 未修改 `ChatTimeline.vue`
- [x] 未修改 `AgentStatusPanel.vue`
- [x] 未新增或改写 `agent-tone-*` 类定义（新增 `--chain-*` 独立 token，收在 `.mode-workflow` 作用域）
- [x] 三态色取自既有色板：`#64748b` / `#f59e0b` / `#19e58f`
- [x] `prefers-reduced-motion` 降级已实现（关闭 animation 并清除 `stroke-dasharray`）

## 6. 验收标准核对

| 编号 | 标准摘要 | 结论 | 证据 |
| --- | --- | --- | --- |
| AC-1 | 系统 Agent 显示名称，无裸 UUID | 通过 | `CollaborationLogPanel.spec.ts` 三项断言，含 UUID 正则否定断言 |
| AC-2 | 连续心跳折叠并累计秒数 | 通过 | `CollaborationLogPanel.spec.ts` 四项断言（折叠、跨 invocation 不合并、被真实事件打断不合并、窗口内保留真实事件） |
| AC-3 | 节点 DOM 不含执行细节文本 | 通过 | 模型层断言「输出不泄漏到节点标签」；模板节点仅渲染序号/名称/状态；CSS `max-height: 76px` + `text-overflow: ellipsis` 兜底（后两项为代码检查） |
| AC-4 | 画布无装饰元素 | 通过 | grep 确认 `workflow-hub` / `workflow-output` / `workflow-arrow` / 连线拖拽代码全部不存在（代码检查） |
| AC-5 | 每节点恰好一个三态类 | 通过 | 模型层断言 `state` 为单值且三态互斥；模板以 `is-${node.state}` 单类绑定（后者为代码检查） |
| AC-6 | 脉冲仅在 done→active 非 fallback 边 | 通过 | `workflowChainModel.spec.ts` 五项断言，含 fallback 排除与上下游状态不符两种否定用例 |
| AC-7 | reduced-motion 下无动画 | 通过 | `styles.css` `@media (prefers-reduced-motion: reduce)` 块（代码检查） |
| AC-8 | 详情面板含能力与输出 | 通过 | `WorkflowAgentInspector.vue` 渲染能力清单与本次任务输出，含空态文案（代码检查） |
| AC-9 | 讨论区按 round 分组 | 通过 | `workflowChainModel.spec.ts` 四项断言，含 `phase` 缺失、非讨论流量排除、轮次内保序 |
| AC-10 | 文案门禁覆盖新视图 | 通过 | `chinese-visible-copy-smoke.mjs` 已纳入两个新组件，门禁 exit 0 |
| AC-11 | 群聊快照零 diff | 通过 | `ChatSurfaceBaseline.spec.ts` 7/7，在 T1/T3/T4 每批改动后复跑通过 |

AC-3/AC-4/AC-5/AC-7/AC-8 的部分证据为代码检查而非自动化断言，原因见第 8 节。

## 7. 测试执行

| 命令 | 结论 | 备注 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | 根脚本用 `--if-present` 遍历 workspace；`@project/web` 未定义该脚本会被跳过，故另行直接执行 `vue-tsc` |
| `apps/web/node_modules/.bin/vue-tsc --noEmit` | 通过（exit 0） | 覆盖 `.vue` 模板类型检查，是本次前端改动的实际类型门禁 |
| `npm run test -w @project/web` | 通过 | 45 个文件 216 项全绿 |
| `npm run test:e2e:chinese-copy` | 通过（exit 0） | `chinese visible copy smoke ok` |
| `npm run test:harness` | 通过（exit 0） | 含新增 `workflow-view-docs` 门禁 16/16 |

分任务测试结果：T0 7/7、T1 7/7（对旧组件先失败 5/7，证明断言有效）、T2 22/22（先失败于模块缺失，再失败 2 项后修正）。

## 8. 剩余风险

| 风险 | 影响 | 建议 |
| --- | --- | --- |
| `WorkflowRuntimeView.vue` 与 `WorkflowAgentInspector.vue` 无组件级单元测试 | 中 | 目前仅由 `vue-tsc` 与文案门禁覆盖。建议补 mount 测试断言三态类名、节点 DOM 文本长度上限、脉冲类名，把 AC-3/AC-4/AC-5/AC-8 从代码检查升级为自动化 |
| 脉冲动画未做真实数据目视确认 | 低 | 需在真实会话下开工作流视图确认动画方向与节奏 |
| 三态与既有「状态说明」图例语义 | 低 | 图例已改为三态文案，与画布一致；若后续恢复四态需同步 |
| `failed` 归入 `active` | 低 | 需求非目标明确本次只做三态。失败态目前显示为「执行中」，若需单独提示应另开需求 |

## 9. 交接

- 下游消费者：Review 阶段。
- 服务端零改动，无需 `dev:restart-server`；前端由 Vite HMR 生效。
- 群聊视图零影响已验证：`CollaborationLogPanel` 在群聊模式下不挂载，T0 基线在每批改动后复跑通过。
- 协作图与调试视图共用右侧面板，会继承 T1 的名称解析与心跳折叠修复，属预期正向影响。
- 若 Review 阶段发现设计不足：按 [`../harness-engineering/feedback-loop/07-feedback-loop.md`](../harness-engineering/feedback-loop/07-feedback-loop.md) 回退到 `design` 并更新设计文档版本。
