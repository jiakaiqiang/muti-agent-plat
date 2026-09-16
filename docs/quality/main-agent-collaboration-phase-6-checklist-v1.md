# 阶段 6：双端综合验收、长会话成本评测与受控上线 — Checklist v1

> 日期：2026-09-16
> 状态：设计与实施基线，待实施；现有能力的复用不代表本阶段验收已完成。
> 依赖：阶段 0、1、2A、2B、2C、3、4、5 均完成独立退出验收。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-6-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-6-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-6-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-6-checklist-v1.md)

## 1. 验收矩阵

| 验收 ID | 关联任务 | 场景与预期 | 状态/证据 |
| --- | --- | --- | --- |
| P6-AC1 | P6-T1、P6-T6 | 追踪矩阵无孤立 AC/Task，任何缺少必须证据的阶段不能标完成。 | 待验证 |
| P6-AC2 | P6-T2、P6-T5 | 所有模型调用通过完整预算；无关历史从 10 增至 100 个需求时，固定当前任务的受控输入不超过 1.2 倍基线且不超过配置上限。 | 待验证 |
| P6-AC3 | P6-T2、P6-T5 | 固定验收集中安全/授权用例 100% 正确；召回/歧义分类每条有预期，失败样本不得用缓存命中掩盖。 | 待验证 |
| P6-AC4 | P6-T3 | 每个竞争场景业务效果最多一次；未知停止持续阻塞；重启不增加未授权模型调用。 | 待验证 |
| P6-AC5 | P6-T4 | 两端同时操作同一会话，旧快照不回退新状态；另一会话不受停止/删除影响；桌面布局不替换 Web 样式。 | 待验证 |
| P6-AC6 | P6-T5 | 固定相同任务/模型/输出上限比对，真实调用须批准；价格或 usage 缺失标 unknown，不承诺百分比降本。 | 待验证 |
| P6-AC7 | P6-T6 | 故障演练能停用新入口而不清库；旧构建不兼容时执行向前修复，生产上线有单独授权记录。 | 待验证 |

## 2. 现有验证入口

以下命令从仓库根目录运行，是后续实施回归入口，本次文档交付未执行这些业务测试。运行 E2E 前检查脚本使用隔离环境/mock，不能默认连接当前业务服务或真实模型。

```powershell
npm run typecheck
npm run test
npm run test:harness
npm run build
npm run test:e2e:main-chain
npm run test:e2e:client-presentation
npm run test:e2e:desktop-render
npm run test:e2e:workflow-managed-execution
npm run test:e2e:rework-loop
npm run test:e2e:token-budget
```

相关既有测试：

- [postgres-migration-runner.integration.spec.ts](../../apps/server/src/modules/persistence/relational/postgres-migration-runner.integration.spec.ts)
- [WorkspaceSync.spec.ts](../../apps/web/src/components/WorkspaceSync.spec.ts)
- [client-presentation-smoke.mjs](../../tests/e2e/client-presentation-smoke.mjs)

## 3. 必须补充的测试

- [ ] 主 Agent 全链路组合 E2E（待新增；不能用现有冒烟脚本代替）。
- [ ] 百需求千消息预算/召回/缓存评测（待新增；不能用现有冒烟脚本代替）。
- [ ] 多进程讨论/确认/删除故障矩阵（待新增；不能用现有冒烟脚本代替）。

## 4. 跨阶段安全复核

- [ ] file/PostgreSQL 行为对等；涉及并发的场景用独立 PostgreSQL 和独立连接/实例验证，不只使用 mock。
- [ ] 重复、乱序、重启、取消/删除、迟到结果均不破坏幂等与版本边界。
- [ ] 未确认范围、高风险动作、未知停止状态均不会被摘要/缓存/模型判断绕过。
- [ ] 双端保持同一业务状态和各自样式；不依赖刷新才能修复状态。
- [ ] 无凭据、完整敏感提示或用户私有正文进入测试报告与指标。
- [ ] 所有文档/合同更新与实际实现一致，回退方案已演练或明确未执行。

## 5. 证据记录

每个结果记录：日期、构建/工作树版本、执行环境、fixture、命令、退出码、观察结果和证据路径；未执行/跳过必须写原因，不能记作通过。真实模型验证与 stub 验证分开记录。

阶段通过条件：所有硬性安全/一致性门禁与双端闭环通过；性能/成本/真实模型验证范围如实记录；测试完成不等同已经发布。

本次初始状态：所有业务验收待验证；只完成 SDD 文档编制，不代表功能已经开发或上线。
