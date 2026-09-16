# 阶段 4：主 Agent 文档、精确确认与所选工作流交接 — Checklist v1

> 日期：2026-09-16
> 状态：设计与实施基线，待实施；现有能力的复用不代表本阶段验收已完成。
> 依赖：阶段 3 通过，复用 1 与 2A～2C 的隔离、预算、记忆和缓存。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-4-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-4-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-4-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-4-checklist-v1.md)

## 1. 验收矩阵

| 验收 ID | 关联任务 | 场景与预期 | 状态/证据 |
| --- | --- | --- | --- |
| P4-AC1 | P4-T1、P4-T6 | 专家提出修订后，只有主 Agent 发布的新版本进入正式确认；文档引用当前需求与有效来源。 | 待验证 |
| P4-AC2 | P4-T1、P4-T2、P4-T5、P4-T6 | 用户打开 v1/v2 能看到准确改动及历史内容；不存在显示 v1、实际确认 v2 的情况。 | 待验证 |
| P4-AC3 | P4-T2、P4-T4、P4-T6 | 两端同时确认只提交一次；旧卡片不能批准新文档或另一需求；未确认需求不能进入执行。 | 待验证 |
| P4-AC4 | P4-T3、P4-T5、P4-T6 | 确认需求前点击流程仅可预览；选择已下架/不兼容版本返回解释，不自动换图。 | 待验证 |
| P4-AC5 | P4-T3、P4-T4、P4-T6 | 所选图缺质量 Agent 时不启动半条流程；完成用户映射后按同一确认范围校验再启动。 | 待验证 |
| P4-AC6 | P4-T4、P4-T6 | 提交成功后网络断开/派发前崩溃，再次点击或重启最多一个有效运行；相同请求不同载荷被拒绝。 | 待验证 |
| P4-AC7 | P4-T5、P4-T6 | 质量拒绝进入可解释返工或主 Agent 决策，不能仅卡在非终态；专家不能改图绕过质量节点。 | 待验证 |

## 2. 现有验证入口

以下命令从仓库根目录运行，是后续实施回归入口，本次文档交付未执行这些业务测试。运行 E2E 前检查脚本使用隔离环境/mock，不能默认连接当前业务服务或真实模型。

```powershell
npm run test:e2e:memory-confirm
npm run test:e2e:workflow-managed-execution
npm run test:e2e:workflow-agent-substitution
npm run test:e2e:rework-loop
npm run test:e2e:codex-task-workspace
```

相关既有测试：

- [workflow-session-flow.spec.ts](../../apps/server/src/modules/sessions/workflow-session-flow.spec.ts)
- [workflow-runtime.service.spec.ts](../../apps/server/src/modules/workflows/workflow-runtime.service.spec.ts)
- [ConfirmationCard.spec.ts](../../apps/desktop/renderer/components/ConfirmationCard.spec.ts)

## 3. 必须补充的测试

- [ ] 需求/文档/流程三版本精确确认合同测试（待新增；不能用现有冒烟脚本代替）。
- [ ] 双端重复确认与启动派发崩溃 PostgreSQL 集成测试（待新增；不能用现有冒烟脚本代替）。

## 4. 跨阶段安全复核

- [ ] file/PostgreSQL 行为对等；涉及并发的场景用独立 PostgreSQL 和独立连接/实例验证，不只使用 mock。
- [ ] 重复、乱序、重启、取消/删除、迟到结果均不破坏幂等与版本边界。
- [ ] 未确认范围、高风险动作、未知停止状态均不会被摘要/缓存/模型判断绕过。
- [ ] 双端保持同一业务状态和各自样式；不依赖刷新才能修复状态。
- [ ] 无凭据、完整敏感提示或用户私有正文进入测试报告与指标。
- [ ] 所有文档/合同更新与实际实现一致，回退方案已演练或明确未执行。

## 5. 证据记录

每个结果记录：日期、构建/工作树版本、执行环境、fixture、命令、退出码、观察结果和证据路径；未执行/跳过必须写原因，不能记作通过。真实模型验证与 stub 验证分开记录。

阶段通过条件：当前文档确认后按用户所选流程唯一启动，过期/重复操作安全；Diff、成员映射和质量返工可追溯。

本次初始状态：所有业务验收待验证；只完成 SDD 文档编制，不代表功能已经开发或上线。
