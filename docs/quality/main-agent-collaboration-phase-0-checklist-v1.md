# 阶段 0：合同收敛、现状基线与迁移边界 — Checklist v1

> 日期：2026-09-16
> 状态：设计与实施基线，待实施；现有能力的复用不代表本阶段验收已完成。
> 依赖：无；作为所有阶段的入口。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-0-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-0-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-0-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-0-checklist-v1.md)

## 1. 验收矩阵

| 验收 ID | 关联任务 | 场景与预期 | 状态/证据 |
| --- | --- | --- | --- |
| P0-AC1 | P0-T1、P0-T2、P0-T5 | 给定两个会话使用同一 agentId，合同能唯一关联各自需求、调用、取消目标与产物。 | 待验证 |
| P0-AC2 | P0-T2、P0-T3 | 逐一审核消息、确认、文档、流程启动的所有权矩阵，无两个组件同时拥有最终决定权。 | 待验证 |
| P0-AC3 | P0-T3、P0-T6 | 主流程案例同时覆盖用户 @ 专家、主 Agent 咨询、成员选择、文档确认和用户选择流程。 | 待验证 |
| P0-AC4 | P0-T4、P0-T5 | 查阅类型、迁移、运行时合同，不引入 v1 回退、不把摘要或分类结果当作执行授权。 | 待验证 |
| P0-AC5 | P0-T1、P0-T5、P0-T6 | 清单列出现有停止/持久化能力、物理删除语义、摘要限制、讨论行为，以及对应源码和重新验证任务。 | 待验证 |
| P0-AC6 | P0-T4、P0-T6 | 旧构建不识别新状态时阻止接管；关闭新入口不删除新数据或放开停止屏障。 | 待验证 |

## 2. 现有验证入口

以下命令从仓库根目录运行，是后续实施回归入口，本次文档交付未执行这些业务测试。运行 E2E 前检查脚本使用隔离环境/mock，不能默认连接当前业务服务或真实模型。

```powershell
npm run test -w @agent-cluster/shared
npm run typecheck
npm run test:harness
```

相关既有测试：

- [system-agent-runtime-policy.service.spec.ts](../../apps/server/src/modules/agents/system-agent-runtime-policy.service.spec.ts)
- [context-management.service.spec.ts](../../apps/server/src/modules/context-management/context-management.service.spec.ts)

## 3. 必须补充的测试

- [ ] 身份链/角色所有权合同测试（待新增；不能用现有冒烟脚本代替）。
- [ ] 新增状态的新旧客户端兼容测试（待新增；不能用现有冒烟脚本代替）。

## 4. 跨阶段安全复核

- [ ] file/PostgreSQL 行为对等；涉及并发的场景用独立 PostgreSQL 和独立连接/实例验证，不只使用 mock。
- [ ] 重复、乱序、重启、取消/删除、迟到结果均不破坏幂等与版本边界。
- [ ] 未确认范围、高风险动作、未知停止状态均不会被摘要/缓存/模型判断绕过。
- [ ] 双端保持同一业务状态和各自样式；不依赖刷新才能修复状态。
- [ ] 无凭据、完整敏感提示或用户私有正文进入测试报告与指标。
- [ ] 所有文档/合同更新与实际实现一致，回退方案已演练或明确未执行。

## 5. 证据记录

每个结果记录：日期、构建/工作树版本、执行环境、fixture、命令、退出码、观察结果和证据路径；未执行/跳过必须写原因，不能记作通过。真实模型验证与 stub 验证分开记录。

阶段通过条件：AC 全部有审查/测试证据；状态所有权、迁移与策略快照明确；实现边界没有待裁决冲突。

本次初始状态：所有业务验收待验证；只完成 SDD 文档编制，不代表功能已经开发或上线。
