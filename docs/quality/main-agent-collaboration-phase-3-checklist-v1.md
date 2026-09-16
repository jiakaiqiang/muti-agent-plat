# 阶段 3：主 Agent 主持讨论与可恢复专家协作 — Checklist v1

> 日期：2026-09-16
> 状态：设计与实施基线，待实施；现有能力的复用不代表本阶段验收已完成。
> 依赖：阶段 1、2A、2B、2C 通过；核心正确性不依赖缓存命中。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-3-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-3-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-3-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-3-checklist-v1.md)

## 1. 验收矩阵

| 验收 ID | 关联任务 | 场景与预期 | 状态/证据 |
| --- | --- | --- | --- |
| P3-AC1 | P3-T1、P3-T2、P3-T5、P3-T6 | 简单补充可主 Agent 处理；涉及前后端约束时按需邀请相关已选专家，最终都有主 Agent 综合结论。 | 待验证 |
| P3-AC2 | P3-T4、P3-T5、P3-T6 | 讨论进行中用户 @ 质量 Agent 补充验收，形成独立可追踪委派并进入本轮/下一有效轮次汇总。 | 待验证 |
| P3-AC3 | P3-T2、P3-T6 | 模型请求陌生 Agent 或禁用 Agent 时产生主 Agent 的成员选择请求，未确认前不调用。 | 待验证 |
| P3-AC4 | P3-T1、P3-T3、P3-T6 | 提交后崩溃、完成事件重复、结果乱序时，同一委派最多一次有效完成，账单按实际尝试记录。 | 待验证 |
| P3-AC5 | P3-T2、P3-T5、P3-T6 | 两个专家意见相反时，主 Agent 明确分歧和选项；必需专家失败不以完整方案结束。 | 待验证 |
| P3-AC6 | P3-T1、P3-T2、P3-T3、P3-T6 | 专家超时、拒绝、缺证、主 Agent 失败分别有固定状态与恢复点；停止后所有派生咨询停稳。 | 待验证 |
| P3-AC7 | P3-T1、P3-T4、P3-T5、P3-T6 | 专家执行期间修订需求，旧版本结果只留历史；刷新任一端不会将过期建议当新结论。 | 待验证 |

## 2. 现有验证入口

以下命令从仓库根目录运行，是后续实施回归入口，本次文档交付未执行这些业务测试。运行 E2E 前检查脚本使用隔离环境/mock，不能默认连接当前业务服务或真实模型。

```powershell
npm run test:e2e:multi-agent-discussion
node node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json --test apps/server/src/modules/orchestrator/orchestrator.service.spec.ts apps/server/src/modules/orchestrator/bounded-consultation.spec.ts
npm run test -w @project/web
npm run test:desktop
```

相关既有测试：

- [orchestrator.service.spec.ts](../../apps/server/src/modules/orchestrator/orchestrator.service.spec.ts)
- [SessionWorkspace.spec.ts](../../apps/web/src/components/SessionWorkspace.spec.ts)

## 3. 必须补充的测试

- [ ] 持久化主 Agent 讨论/委派恢复测试（待新增；不能用现有冒烟脚本代替）。
- [ ] 用户中途 @ 与成员外邀请双端 E2E（待新增；不能用现有冒烟脚本代替）。
- [ ] 专家分歧及必需咨询失败不得假成功测试（待新增；不能用现有冒烟脚本代替）。

## 4. 跨阶段安全复核

- [ ] file/PostgreSQL 行为对等；涉及并发的场景用独立 PostgreSQL 和独立连接/实例验证，不只使用 mock。
- [ ] 重复、乱序、重启、取消/删除、迟到结果均不破坏幂等与版本边界。
- [ ] 未确认范围、高风险动作、未知停止状态均不会被摘要/缓存/模型判断绕过。
- [ ] 双端保持同一业务状态和各自样式；不依赖刷新才能修复状态。
- [ ] 无凭据、完整敏感提示或用户私有正文进入测试报告与指标。
- [ ] 所有文档/合同更新与实际实现一致，回退方案已演练或明确未执行。

## 5. 证据记录

每个结果记录：日期、构建/工作树版本、执行环境、fixture、命令、退出码、观察结果和证据路径；未执行/跳过必须写原因，不能记作通过。真实模型验证与 stub 验证分开记录。

阶段通过条件：用户 @、按需咨询、主 Agent 实质汇总、统一澄清、成员授权、版本与重启恢复全部通过，讨论无源码写副作用。

本次初始状态：所有业务验收待验证；只完成 SDD 文档编制，不代表功能已经开发或上线。
