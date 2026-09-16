# 阶段 5：执行中补充、新需求与范围变更治理 — Checklist v1

> 日期：2026-09-16
> 状态：设计与实施基线，待实施；现有能力的复用不代表本阶段验收已完成。
> 依赖：阶段 4 通过；使用 2A 意图、2B 决策版本和 3 主 Agent 协作。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-5-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-5-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-5-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-5-checklist-v1.md)

## 1. 验收矩阵

| 验收 ID | 关联任务 | 场景与预期 | 状态/证据 |
| --- | --- | --- | --- |
| P5-AC1 | P5-T1、P5-T2、P5-T6 | 询问“做到哪里了”不取消运行；“停止”优先走停止屏障；“顺便加一个导出”不会直接改变运行输入。 | 待验证 |
| P5-AC2 | P5-T2、P5-T6 | 执行中 @ 架构 Agent 询问影响，仅产生目标咨询，不重跑全部专家和工作流节点。 | 待验证 |
| P5-AC3 | P5-T1、P5-T2、P5-T3、P5-T6 | 主 Agent 展示受影响任务/文件/确认版本与代价；用户未选前不修改当前需求契约。 | 待验证 |
| P5-AC4 | P5-T3、P5-T5、P5-T6 | 旧调用迟到完成不能被算作新需求成果；旧版本测试结果不能直接为新验收背书。 | 待验证 |
| P5-AC5 | P5-T1、P5-T4、P5-T6 | 独立需求不携带当前需求全部历史；相关需求引用范围明确，选择成员不会改变共享 Agent 定义。 | 待验证 |
| P5-AC6 | P5-T1、P5-T4、P5-T5、P5-T6 | 双端重复提交只排队一次；当前运行结束后下一需求进入主 Agent 讨论/待确认，不跳过文档及流程选择。 | 待验证 |
| P5-AC7 | P5-T5、P5-T6 | 删除会话后 ChangeRequest 回调只允许审计；重启后保留用户选择、已完成分析和未决状态，不自动重播模型。 | 待验证 |

## 2. 现有验证入口

以下命令从仓库根目录运行，是后续实施回归入口，本次文档交付未执行这些业务测试。运行 E2E 前检查脚本使用隔离环境/mock，不能默认连接当前业务服务或真实模型。

```powershell
npm run test:e2e:browser-executing-user-interrupt
npm run test:e2e:browser-brief-revision
npm run test:e2e:recovery
node node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json --test apps/server/src/modules/sessions/sessions.service.spec.ts apps/server/src/modules/context-management/context-management.service.spec.ts
```

相关既有测试：

- [command-application.service.spec.ts](../../apps/server/src/modules/message-routing/command-application.service.spec.ts)
- [workflow-session-flow.spec.ts](../../apps/server/src/modules/sessions/workflow-session-flow.spec.ts)

## 3. 必须补充的测试

- [ ] ChangeRequest 版本/选择/队列并发测试（待新增；不能用现有冒烟脚本代替）。
- [ ] 执行中 @、暂停修订和新需求排队双端 E2E（待新增；不能用现有冒烟脚本代替）。

## 4. 跨阶段安全复核

- [ ] file/PostgreSQL 行为对等；涉及并发的场景用独立 PostgreSQL 和独立连接/实例验证，不只使用 mock。
- [ ] 重复、乱序、重启、取消/删除、迟到结果均不破坏幂等与版本边界。
- [ ] 未确认范围、高风险动作、未知停止状态均不会被摘要/缓存/模型判断绕过。
- [ ] 双端保持同一业务状态和各自样式；不依赖刷新才能修复状态。
- [ ] 无凭据、完整敏感提示或用户私有正文进入测试报告与指标。
- [ ] 所有文档/合同更新与实际实现一致，回退方案已演练或明确未执行。

## 5. 证据记录

每个结果记录：日期、构建/工作树版本、执行环境、fixture、命令、退出码、观察结果和证据路径；未执行/跳过必须写原因，不能记作通过。真实模型验证与 stub 验证分开记录。

阶段通过条件：执行期提问不误中断，范围变更经用户选择和重确认，新需求独立排队，旧回调/重启不误执行。

本次初始状态：所有业务验收待验证；只完成 SDD 文档编制，不代表功能已经开发或上线。
