# 阶段 1：多会话执行隔离、停止与可恢复删除 — Checklist v1

> 日期：2026-09-16
> 状态：设计与实施基线，待实施；现有能力的复用不代表本阶段验收已完成。
> 依赖：阶段 0 通过。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-1-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-1-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-1-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-1-checklist-v1.md)

## 1. 验收矩阵

| 验收 ID | 关联任务 | 场景与预期 | 状态/证据 |
| --- | --- | --- | --- |
| P1-AC1 | P1-T1、P1-T3、P1-T6 | A、B 共用 Agent 与设备并发执行；停止 A 后 B 的调用、事件和目录内容继续正常。 | 待验证 |
| P1-AC2 | P1-T2、P1-T3、P1-T6 | 两个独立数据库连接竞争 reserve/stop，不出现停止目标快照外的新调用逃逸。 | 待验证 |
| P1-AC3 | P1-T3、P1-T5、P1-T6 | 进程已退出但数据库失败时显示待同步，resume 仍拒绝；恢复落库后允许用户显式继续。 | 待验证 |
| P1-AC4 | P1-T2、P1-T4、P1-T5、P1-T6 | 重复删除、断线、服务重启均保持同一删除请求，不进入物理清理或重新接任务。 | 待验证 |
| P1-AC5 | P1-T2、P1-T4、P1-T6 | 删除后到达专家完成、摘要完成、旧 CLI 结果，仅记录允许的审计，不产生新任务或可检索记忆。 | 待验证 |
| P1-AC6 | P1-T4、P1-T5、P1-T6 | 恢复隐藏会话可查看历史产物，需显式继续；在同目录双会话测试中验证另一会话文件未变化。 | 待验证 |

## 2. 现有验证入口

以下命令从仓库根目录运行，是后续实施回归入口，本次文档交付未执行这些业务测试。运行 E2E 前检查脚本使用隔离环境/mock，不能默认连接当前业务服务或真实模型。

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json --test apps/server/src/modules/sessions/sessions.service.spec.ts apps/server/src/modules/runtimes/logical-operation-store.spec.ts
npm run test -w @agent-cluster/local-runtime-cli
npm run test:e2e:cancel
npm run test:e2e:recovery
```

相关既有测试：

- [local-runtime-connection.service.spec.ts](../../apps/server/src/modules/local-runtime/local-runtime-connection.service.spec.ts)
- [runtime-process-stop.spec.ts](../../packages/local-runtime-cli/src/runtime-process-stop.spec.ts)
- [runtime-stop-state.spec.ts](../../apps/web/src/stores/runtime-stop-state.spec.ts)

## 3. 必须补充的测试

- [ ] 跨进程 reserve/stop/delete 竞争与墓碑恢复测试（待新增；不能用现有冒烟脚本代替）。
- [ ] 可恢复删除及同 Agent 多会话双端 E2E（待新增；不能用现有冒烟脚本代替）。

## 4. 跨阶段安全复核

- [ ] file/PostgreSQL 行为对等；涉及并发的场景用独立 PostgreSQL 和独立连接/实例验证，不只使用 mock。
- [ ] 重复、乱序、重启、取消/删除、迟到结果均不破坏幂等与版本边界。
- [ ] 未确认范围、高风险动作、未知停止状态均不会被摘要/缓存/模型判断绕过。
- [ ] 双端保持同一业务状态和各自样式；不依赖刷新才能修复状态。
- [ ] 无凭据、完整敏感提示或用户私有正文进入测试报告与指标。
- [ ] 所有文档/合同更新与实际实现一致，回退方案已演练或明确未执行。

## 5. 证据记录

每个结果记录：日期、构建/工作树版本、执行环境、fixture、命令、退出码、观察结果和证据路径；未执行/跳过必须写原因，不能记作通过。真实模型验证与 stub 验证分开记录。

阶段通过条件：双会话隔离、可信停止、可恢复删除、迟到写回和真实 PostgreSQL 竞争全部通过。

本次初始状态：所有业务验收待验证；只完成 SDD 文档编制，不代表功能已经开发或上线。
