# Session Runtime 动态切换 Tasks v1

状态：2026-10-11 已接通命令/自然语言/API 与接续控制主链，实施范围和限制见 Plan 第 15 节。下方为原完整产品任务清单，未验证的完整验收项不自动勾选完成。

入口：[Spec](../product/session-runtime-switch-spec-v1.md) | [Plan](../design/session-runtime-switch-plan-v1.md) | [Checklist](../quality/session-runtime-switch-checklist-v1.md)。

## 1. 执行规则

- 每项预计 10–15 分钟，采用 red -> green -> refactor；超出 15 分钟必须继续拆分，不把多个失败面混进一个任务。
- 每项只修改表中 allowedPaths；全局 forbiddenPaths：无关 Agent/Skill/Tool 语义、无关工作流、无关页面样式、真实用户数据和供应商配置。
- `tool.file_write` 仅用于 allowedPaths；`tool.command_run` 仅运行定向测试和项目验证；外部网络、真实模型、发布、数据库破坏操作默认 denied，另行取得用户确认。
- 任务状态只有在代码、测试和 Checklist 证据完成后才能勾选。

## 2. 任务拆解

| ID | 预计 | 负责 Agent | 依赖 | allowedPaths | 交付与验收 |
| --- | --- | --- | --- | --- | --- |
| T01 | 10–15m | test | 无 | `apps/server/src/modules/sessions/*.spec.ts` | 固化 PAUSED 下“切换到 Claude Code 继续”被 queued 的失败回归（AC2） |
| T02 | 10–15m | test | 无 | `apps/server/src/modules/orchestrator/*.spec.ts` | 固化用户 Abort 不触发 Provider fallback，以及现有 retry/fallback 基线（AC7） |
| T03 | 10–15m | backend | 无 | `packages/shared/src/contracts.ts`, `packages/shared/src/*.spec.ts` | 增加 RuntimePreference fallback/revision 类型与校验样例（AC6、11） |
| T04 | 10–15m | backend | T03 | `packages/shared/src/contracts.ts`, `packages/shared/src/*.spec.ts` | 增加 RuntimeSwitchRequest/status/fallbackMode 合同（AC8、9） |
| T05 | 10–15m | backend | T04 | `packages/shared/src/contracts.ts`, `apps/server/src/common/execution-termination*` | 增加 runtime_switch termination 与 attempt trace 字段（AC4、7） |
| T06 | 10–15m | backend | T04 | `docs/contracts/api-contract-v0.1.md`, `docs/contracts/event-contract-v0.1.md`, `docs/contracts/runtime-contract-v0.1.md` | 写入 API/Event/Runtime 合同的精确增量（AC12） |
| T07 | 10–15m | backend | T04 | `apps/server/src/modules/runtime-switch/runtime-switch-state.ts`, `*.spec.ts` | 实现纯状态迁移表和非法迁移测试（AC8、9） |
| T08 | 10–15m | backend | T07 | `apps/server/src/modules/runtime-switch/runtime-switch-store.ts`, `*.spec.ts` | 实现 file collection 的创建、查询、幂等键和 CAS（AC8） |
| T09 | 10–15m | backend | T08 | `apps/server/src/modules/persistence/relational/**` | 增加 relational collection 映射和 migration 单元测试（AC9、12） |
| T10 | 10–15m | backend | T09 | `apps/server/src/modules/persistence/relational/**/*integration.spec.ts` | 增加 PostgreSQL 原子更新和并发幂等集成夹具（AC8、12） |
| T11 | 10–15m | backend | T03 | `apps/server/src/modules/sessions/runtime-switch-command.ts`, `*.spec.ts` | 实现 Runtime 别名规范化与明确切换句式解析（AC1、2） |
| T12 | 10–15m | test | T11 | `apps/server/src/modules/sessions/runtime-switch-command.spec.ts` | 覆盖问句、比较、未知 Runtime、只使用和继续语义的负/正样例（AC1、2） |
| T13 | 10–15m | backend | T04 | `apps/server/src/modules/sessions/sessions.controller.ts`, `*controller*.spec.ts` | 增加 POST/GET runtime-switch 合同、Idempotency-Key 和 409 校验（AC8） |
| T14 | 10–15m | backend | T08 | `apps/server/src/modules/runtime-switch/runtime-switch-coordinator.service.ts`, `*.spec.ts` | 实现授权、Session revision 和进行中请求守卫（AC3、8） |
| T15 | 10–15m | backend | T14 | `apps/server/src/modules/runtime-switch/runtime-switch-coordinator.service.ts`, `*.spec.ts` | 接入目标 Runtime 注册/在线预检，失败不停止旧调用（AC3） |
| T16 | 10–15m | backend | T15 | `apps/server/src/modules/runtime-switch/runtime-switch-coordinator.service.ts`, `apps/server/src/modules/runtime-routing/*.spec.ts` | 接入 Workspace/Capability/Tool 的明确目标资格校验（AC3、5） |
| T17 | 10–15m | backend | T05、T16 | `apps/server/src/modules/runtimes/session-lifecycle-store.ts`, `*.spec.ts` | 增加切换关闭准入和 generation fence 测试（AC4） |
| T18 | 10–15m | backend | T17 | `apps/server/src/modules/runtime-switch/runtime-switch-coordinator.service.ts`, `*.spec.ts` | 使用统一 stop-state 创建/复用停止请求并进入 stopping（AC4） |
| T19 | 10–15m | backend | T18 | `apps/server/src/modules/runtime-switch/runtime-switch-coordinator.service.ts`, `*.spec.ts` | 实现停止超时保持 stopping、重复停止幂等（AC4、8） |
| T20 | 10–15m | backend | T09、T19 | `apps/server/src/modules/runtimes/session-lifecycle-store.ts`, `apps/server/src/modules/runtime-switch/**` | 原子实现 completeRuntimeSwitch：偏好/revision/generation/request/event（AC4、8、9） |
| T21 | 10–15m | backend | T20 | `apps/server/src/modules/orchestrator/orchestrator.service.ts`, `*.spec.ts` | 调整 EffectivePolicy：管理员 allowed 上限、Session 显式 preferred 优先（AC11） |
| T22 | 10–15m | backend | T21 | `apps/server/src/modules/orchestrator/orchestrator.service.ts`, `apps/server/src/modules/runtime-routing/**` | 使用 fallbackRuntimeTypes 有序选择并兼容旧 Session（AC6、7） |
| T23 | 10–15m | backend | T22 | `apps/server/src/modules/orchestrator/orchestrator.service.ts`, `*.spec.ts` | 新 attemptGroup 写入 manual_switch trace 和 from/switchRequestId（AC7、12） |
| T24 | 10–15m | backend | T23 | `apps/server/src/modules/orchestrator/orchestrator.service.ts`, `*.spec.ts` | 实现 keep 和 exclude_previous_once 对当前 attemptGroup 的候选行为（AC6） |
| T25 | 10–15m | backend | T24 | `apps/server/src/modules/orchestrator/orchestrator.service.ts`, `*.spec.ts` | 实现 target_only 的原子策略收紧和 fail-closed（AC6） |
| T26 | 10–15m | backend | T20、T23 | `apps/server/src/modules/runtime-switch/**`, `apps/server/src/modules/orchestrator/**` | 新 Runtime 从 Context v2 重建且不携带旧 CLI resume（AC5） |
| T27 | 10–15m | backend | T26 | `apps/server/src/modules/runtime-switch/**`, `apps/server/src/modules/worktree-execution/**` | 校验可信 executionCandidate；无效候选从任务检查点重建（AC5） |
| T28 | 10–15m | backend | T27 | `apps/server/src/modules/sessions/sessions.service.ts`, `*.spec.ts` | PAUSED + resumeAfterSwitch 恢复原阶段并交接 queued FollowUp（AC2） |
| T29 | 10–15m | backend | T11、T28 | `apps/server/src/modules/sessions/sessions.service.ts`, `*.spec.ts` | 在 deferred 判断前接入聊天切换命令，不把控制消息入队（AC1、2） |
| T30 | 10–15m | backend | T20 | `apps/server/src/modules/recovery/**`, `apps/server/src/modules/runtime-switch/**` | 实现 stopping/stop_confirmed/applying 重启恢复（AC9） |
| T31 | 10–15m | test | T30 | `apps/server/src/modules/runtime-switch/*.spec.ts` | 验证 resuming 写任务无可信候选时不自动重放（AC9） |
| T32 | 10–15m | backend | T20 | `apps/server/src/modules/events/**`, `packages/shared/src/contracts.ts` | 新增 runtime_switch_changed 事件和事务 outbox 幂等键（AC8、10） |
| T33 | 10–15m | frontend | T13、T32 | `apps/web/src/stores/session.ts`, `apps/web/src/types/contracts.ts`, `*.spec.ts` | 增加切换 API、快照和 SSE version 收敛（AC10） |
| T34 | 10–15m | frontend | T33 | `apps/web/src/components/SessionWorkspace.vue`, `apps/web/src/components/*.spec.ts` | 增加首选/活动/备用 Runtime 状态与切换入口（AC10） |
| T35 | 10–15m | frontend | T34 | `apps/web/src/components/SessionWorkspace.vue`, `apps/web/src/styles.css`, `*.spec.ts` | 展示 stopping/failed/blocked，防重复提交且保留停止操作（AC10） |
| T36 | 10–15m | test | T35 | `apps/web/src/components/*.spec.ts`, `tests/e2e/**` | 覆盖桌面/窄屏、刷新、SSE 重连和旧事件不倒退（AC10） |
| T37 | 10–15m | test | T29 | `apps/server/src/modules/sessions/*.spec.ts`, `apps/server/src/modules/runtime-switch/*.spec.ts` | 复现原故障并验证 Codex -> Claude Code 完整接管（AC1、2） |
| T38 | 10–15m | test | T25、T37 | `apps/server/src/modules/orchestrator/*.spec.ts` | 验证三种 fallbackMode、不可重试失败和授权不扩大（AC6、7） |
| T39 | 10–15m | test | T30、T32 | `apps/server/src/modules/persistence/**/*spec.ts`, `tests/e2e/**` | 注入重启、迟到结果、并发切换和 stale revision（AC4、8、9） |
| T40 | 10–15m | review | T06、T39 | `docs/contracts/**`, 本四件套 | 对齐合同、代码、事件和文案，回填实际文件/迁移号（AC12） |
| T41 | 10–15m | test | T36、T40 | 只运行命令，不改业务代码 | 执行定向 server/web/shared、typecheck 和文档检查，记录结果（AC12） |
| T42 | 10–15m | test | T41 | 只运行命令，不改业务代码 | 执行 runtime-routing/cancel/recovery/client-presentation E2E（AC12） |
| T43 | 10–15m | review | T42 | `docs/quality/session-runtime-switch-checklist-v1.md` | 逐项回填 AC1-AC12 证据；未通过/跳过不得勾选 |

## 3. 依赖图

```text
T01-T02 -----> T37-T39
T03 -> T04 -> T05-T06-T07 -> T08 -> T09 -> T10
T11 -> T12 -> T29
T13 -> T14 -> T15 -> T16 -> T17 -> T18 -> T19 -> T20
T20 -> T21 -> T22 -> T23 -> T24 -> T25
T20/T23 -> T26 -> T27 -> T28 -> T29
T20 -> T30 -> T31
T20 -> T32 -> T33 -> T34 -> T35 -> T36
T29/T25/T30/T32 -> T37-T39 -> T40 -> T41 -> T42 -> T43
```

关键路径：合同 -> 持久化状态机 -> 停止屏障 -> 原子应用 -> Context 接管 -> 前端状态 -> 故障矩阵 -> 验收。

## 4. 阶段退出条件

### A. 合同与状态基础（T01-T12）

- 失败回归稳定；共享类型、状态机和持久化结构可独立测试。
- 不声明 Runtime 已可切换。

### B. 服务端切换闭环（T13-T32）

- 预检、停止、原子应用、上下文接管、fallback 和恢复路径通过定向测试。
- 停止未确认和无可信候选必须 fail closed。

### C. 前端与整体验收（T33-T43）

- UI、快照/SSE、窄屏、重启和 E2E 通过。
- Checklist 有实际命令、版本、事件和持久化证据后才允许标记完成。

## 5. 预计验证命令

实施时先用仓库已有脚本确认准确名称，最小集合预计为：

```bash
npm run test -w @agent-cluster/shared
npm run test -w @agent-cluster/server
npm run test -w @project/web
npm run test:e2e:runtime-routing
npm run test:e2e:cancel
npm run test:e2e:recovery
npm run test:e2e:client-presentation
npm run typecheck
npm run test:harness
npm run build
```

真实 Provider 调用、生产数据库迁移、服务发布和历史 Session 恢复不属于默认验证授权，必须单独确认。
