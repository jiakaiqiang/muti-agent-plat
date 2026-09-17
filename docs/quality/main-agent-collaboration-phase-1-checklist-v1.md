# 阶段 1：多会话执行隔离、停止与可恢复删除 — Checklist v1

> 日期：2026-09-16
> 状态：通过（2026-09-16，本地 Windows/Node 20、Mock Runtime、file + 一次性 PostgreSQL）。
> 依赖：阶段 0 通过。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-1-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-1-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-1-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-1-checklist-v1.md)

## 1. 验收矩阵

| 验收 ID | 关联任务 | 场景与预期 | 状态/证据 |
| --- | --- | --- | --- |
| P1-AC1 | P1-T1、P1-T3、P1-T6 | A、B 共用 Agent 与设备并发执行；停止 A 后 B 的调用、事件和目录内容继续正常。 | 通过：Sessions 单测和 `test:e2e:session-delete` 验证 sibling 不受影响。 |
| P1-AC2 | P1-T2、P1-T3、P1-T6 | 两个独立数据库连接竞争 reserve/stop，不出现停止目标快照外的新调用逃逸。 | 通过：PostgreSQL 集成 9/9，覆盖 delete/reserve 与 stop/reserve 竞争。 |
| P1-AC3 | P1-T3、P1-T5、P1-T6 | 进程已退出但数据库失败时显示待同步，resume 仍拒绝；恢复落库后允许用户显式继续。 | 通过：LogicalOperation/停止屏障定向测试、cancel/recovery E2E 与 PostgreSQL 重建测试。 |
| P1-AC4 | P1-T2、P1-T4、P1-T5、P1-T6 | 重复删除、断线、服务重启均保持同一删除请求，不进入物理清理或重新接任务。 | 通过：delete 幂等、超时释放 UI 状态、墓碑投影和不调用 purge 均有断言。 |
| P1-AC5 | P1-T2、P1-T4、P1-T6 | 删除后到达专家完成、摘要完成、旧 CLI 结果，仅记录允许的审计，不产生新任务或可检索记忆。 | 通过：普通执行、队列、意图路由、Runtime 后处理、Memory、Workspace Writeback、LogicalOperation 和 WorkflowRun 使用 generation 门禁，旧结果测试通过。 |
| P1-AC6 | P1-T4、P1-T5、P1-T6 | 恢复隐藏会话可查看历史产物，需显式继续；在同目录双会话测试中验证另一会话文件未变化。 | 通过：恢复保持历史、返回 PAUSED、不自动运行；file E2E 验证显式继续和 sibling 隔离。 |

## 2. 现有验证入口

以下命令均从仓库根目录实际执行。E2E 使用隔离数据文件和 Mock Runtime；PostgreSQL 脚本创建并在 finally 中删除 `agent_cluster_sdd_test_*` 临时库。

```powershell
node node_modules/tsx/dist/cli.mjs --test --tsconfig apps/server/tsconfig.json apps/server/src/modules/execution/execution.service.spec.ts apps/server/src/modules/workflows/workflow-runtime.service.spec.ts apps/server/src/modules/sessions/sessions.service.spec.ts apps/server/src/modules/runtimes/logical-operation-store.spec.ts apps/server/src/modules/memory/memory.service.spec.ts apps/server/src/modules/workspaces/workspace-writeback.service.spec.ts apps/server/src/modules/orchestrator/orchestrator.service.spec.ts
node scripts/test-session-persistence-postgres.mjs
npm run test -w @agent-cluster/local-runtime-cli
npm run test:e2e:cancel
npm run test:e2e:recovery
npm run test:e2e:session-delete
npm run test -w @agent-cluster/shared
npm run test -w @agent-cluster/server
npm run test -w @project/web
npm run test -w @agent-cluster/desktop
npm run build -w @agent-cluster/server
npm run build -w @project/web
npm run build -w @agent-cluster/desktop
npm run typecheck
npm run build
npm run test:dev-supervisor
npm run test:harness
```

相关既有测试：

- [local-runtime-connection.service.spec.ts](../../apps/server/src/modules/local-runtime/local-runtime-connection.service.spec.ts)
- [runtime-process-stop.spec.ts](../../packages/local-runtime-cli/src/runtime-process-stop.spec.ts)
- [runtime-stop-state.spec.ts](../../apps/web/src/stores/runtime-stop-state.spec.ts)

关键结果：Server 阶段核心定向 195/195；PostgreSQL 9/9；Local Runtime CLI 83/83；Shared 107/107；完整 Server 1332 通过、10 项环境跳过，附加开发守护 7/7；Web 60 文件 288/288；Desktop 主进程 13/13；Web/桌面侧栏专项各 4/4；开发监督器 37/37；三项 E2E、根级 typecheck/build 和完整 Harness 均退出码 0。取消 E2E 同时确认结构化暂停不再产生 `SESSION_ADMISSION_CLOSED` crash 日志。

## 3. 必须补充的测试

- [x] 独立 PostgreSQL 连接的 reserve/stop/delete 竞争与墓碑恢复测试。
- [x] 可恢复删除及同 Agent 多会话 E2E；Web/桌面共享 store 行为并分别验证侧栏交互。

## 4. 跨阶段安全复核

- [x] file/PostgreSQL 行为对等；并发场景使用一次性 PostgreSQL 数据库和独立连接验证。
- [x] 重复、乱序、重启、取消/删除、迟到结果不破坏幂等与 generation 边界。
- [x] 未确认范围、高风险动作、未知停止状态不能被恢复或模型流程绕过。
- [x] 双端保持同一业务状态和各自样式；SSE/列表刷新均使用服务端生命周期投影。
- [x] 测试输出和本文未记录凭据、完整敏感提示或用户私有正文。
- [x] 文档/合同与实现一致；非破坏性失败回退已由测试覆盖，破坏性回退未执行并已在 Plan 明确。

## 5. 证据记录

执行日期：2026-09-16。环境：Windows、PowerShell、Node 20.19.6；当前未提交工作树；Mock Runtime；file backend；本机 PostgreSQL 一次性数据库。完整 Server 的 10 项 skip 为平台/可选环境用例，不含本阶段新增生命周期和 PostgreSQL 竞争测试；真实模型验证未执行，也不作为本阶段通过依据。

上述阶段 1 验收命令均已通过。收尾时还对同期新增的意图识别测试执行了不改变业务语义的类型修正，并确认 Server 全量构建与该测试 3/3 通过；不存在已知的跨改动构建阻塞。

阶段通过条件已满足：双会话隔离、可信停止、可恢复删除、迟到写回和真实 PostgreSQL 竞争全部通过。该结论表示当前工作树完成开发与本地验收，不表示已经发布上线。
