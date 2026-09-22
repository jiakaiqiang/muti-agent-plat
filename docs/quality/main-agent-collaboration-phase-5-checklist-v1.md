# 阶段 5：执行中补充、新需求与范围变更治理 — Checklist v1

> 日期：2026-09-16
> 状态：实施完成，自动化验收通过，待用户确认（2026-09-19）。证据见本页矩阵与实施记录。
> 依赖：阶段 4 通过；使用 2A 意图、2B 决策版本和 3 主 Agent 协作。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-5-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-5-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-5-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-5-checklist-v1.md)

## 1. 验收矩阵

| 验收 ID | 关联任务 | 场景与预期 | 状态/证据 |
| --- | --- | --- | --- |
| P5-AC1 | P5-T1、P5-T2、P5-T6 | 询问“做到哪里了”不取消运行；“停止”优先走停止屏障；“顺便加一个导出”不会直接改变运行输入。 | 通过：确定性状态投影、停止优先拆段、范围变更单独建 ChangeRequest；阶段 5 E2E exit 0 |
| P5-AC2 | P5-T2、P5-T6 | 执行中 @ 架构 Agent 询问影响，仅产生目标咨询，不重跑全部专家和工作流节点。 | 通过：SessionsService 定向咨询用例 + E2E 执行中 `@` 场景 |
| P5-AC3 | P5-T1、P5-T2、P5-T3、P5-T6 | 主 Agent 展示受影响任务/文件/确认版本与代价；用户未选前不修改当前需求契约。 | 通过：影响分析卡包含版本/任务/文件与选项，未决前契约保持不变 |
| P5-AC4 | P5-T3、P5-T5、P5-T6 | 旧调用迟到完成不能被算作新需求成果；旧版本测试结果不能直接为新验收背书。 | 通过：需求版本进入验收指纹，旧 generation/旧分析/旧结果均被 fencing 或标 stale |
| P5-AC5 | P5-T1、P5-T4、P5-T6 | 独立需求不携带当前需求全部历史；相关需求引用范围明确，选择成员不会改变共享 Agent 定义。 | 通过：WorkItem 隔离、显式继承校验、稳定队列投影与 Agent 定义只读 |
| P5-AC6 | P5-T1、P5-T4、P5-T5、P5-T6 | 双端重复提交只排队一次；当前运行结束后下一需求进入主 Agent 讨论/待确认，不跳过文档及流程选择。 | 通过：Web/Desktop 幂等提交、FIFO 队列、终态 `next_requirement_pending` 卡不授予执行权 |
| P5-AC7 | P5-T5、P5-T6 | 删除会话后 ChangeRequest 回调只允许审计；重启后保留用户选择、已完成分析和未决状态，不自动重播模型。 | 通过：删除/恢复 generation fencing、重启恢复 store 用例与隔离 E2E |

## 2. 现有验证入口

以下命令从仓库根目录运行，是阶段 5 的回归入口。阶段 5 定向 E2E 使用隔离环境和 mock Runtime，
不会默认连接当前业务服务或真实模型。

```powershell
npm run test:e2e:browser-executing-user-interrupt
npm run test:e2e:browser-brief-revision
npm run test:e2e:recovery
npm run test:e2e:phase-5-execution-change
node node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json --test apps/server/src/modules/sessions/sessions.service.spec.ts apps/server/src/modules/context-management/context-management.service.spec.ts
```

相关既有测试：

- [command-application.service.spec.ts](../../apps/server/src/modules/message-routing/command-application.service.spec.ts)
- [workflow-session-flow.spec.ts](../../apps/server/src/modules/sessions/workflow-session-flow.spec.ts)

## 3. 必须补充的测试

- [x] ChangeRequest 版本/选择/队列并发测试：`change-request-store.spec.ts`、shared 合同/投影用例，
  独立 PostgreSQL `postgres-migration-runner.integration.spec.ts` 15/15。
- [x] 执行中 @、暂停修订和新需求排队双端 E2E：`npm run test:e2e:phase-5-execution-change` exit 0，
  同时验证 Web/Desktop 重复提交幂等和跨会话隔离。

## 4. 跨阶段安全复核

- [x] file/PostgreSQL 行为对等；涉及并发的场景用独立 PostgreSQL 和独立连接/实例验证，不只使用 mock。
  变更请求集成测试 15/15。
- [x] 重复、乱序、重启、取消/删除、迟到结果均不破坏幂等与版本边界。
  证据包括 sourceEventId、generation、requirementVersion 和队列逻辑键守卫。
- [x] 未确认范围、高风险动作、未知停止状态均不会被摘要/缓存/模型判断绕过。
  影响分析只读，用户选择是唯一状态推进入口。
- [x] 双端保持同一业务状态和各自样式；不依赖刷新才能修复状态。
  shared 投影、Web/ Desktop renderer 单测和真实服务 E2E 均通过；真实浏览器快照另列遗留。
- [x] 无凭据、完整敏感提示或用户私有正文进入测试报告与指标。
  变更卡只投影结构化摘要/版本/引用，不携带模型推理正文。
- [x] 所有文档/合同更新与实际实现一致，回退方案已记录但未演练。
  回退方式为关闭 `MAIN_AGENT_DISCUSSION_ENABLED` 或回到旧入口，不删除持久化记录。

## 5. 证据记录

每个结果记录：日期、构建/工作树版本、执行环境、fixture、命令、退出码、观察结果和证据路径；未执行/跳过必须写原因，不能记作通过。真实模型验证与 stub 验证分开记录。

阶段通过条件：执行期提问不误中断，范围变更经用户选择和重确认，新需求独立排队，旧回调/重启不误执行。

## 6. 阶段 5 实施记录（2026-09-19）

- 定向回归：shared 合同/投影、ChangeRequestStore、SessionsService、WorkflowRuntimeService 均通过；
  重点覆盖多意图拆分、版本过期、旧结果/generation fencing、暂停修订、FIFO 排队、跨会话隔离和删除审计。
- PostgreSQL：使用一次性独立数据库和独立连接执行 `postgres-migration-runner.integration.spec.ts`，15/15 通过。
- E2E：`npm run test:e2e:phase-5-execution-change` exit 0，覆盖停止优先、重复提交幂等、暂停修订、
  队列顺序、跨会话停止和执行中 `@` 咨询。
- 四项门禁：`npm run typecheck`、`npm run test`、`npm run test:harness`、`npm run build` 均 exit 0。
- 限定：未调用真实付费模型，未部署/发布；真实进程级崩溃注入、浏览器快照、跨实例 CAS、流程下架竞争和
  `blocked` 委派写入方仍是跨阶段遗留，不计入本阶段自动化通过。

阶段结论：P5-AC1～P5-AC7 已有自动化证据，阶段 5 实施与自动化验收完成，待用户确认后进入阶段 6。
