# Session Runtime 动态切换 Checklist v1

状态：2026-10-11 控制与接续主链已有定向回归证据，完整 AC 仍按下方矩阵逐项验收，不以单元测试代替真实供应商、专用 UI 或多副本故障演练。

本轮证据：server 321 项定向用例（最后一次 Orchestrator 测试夹具修正后单独重跑其 88 项全部通过）；shared/local-runtime 64 项通过，共 385 项。全仓 `npm run typecheck` 通过，shared/server/local-runtime 构建通过，改动文件 `git diff --check` 通过。开发后端重新加载，本地 Runtime 空闲重载；8089 代理健康检查 200、8099 健康正常，GET runtime-switch 可用。未调用真实模型或重跑用户业务会话。

关键新增测试：`runtime-control-intent.spec.ts`、`runtime-failover-policy.spec.ts`、`runtime-switch-coordinator.spec.ts`，以及 sessions/orchestrator/worktree-execution 回归。当前实现和意图识别分层见 Plan 第 15 节。

关联：[Spec](../product/session-runtime-switch-spec-v1.md) | [Plan](../design/session-runtime-switch-plan-v1.md) | [Tasks](../implementation/session-runtime-switch-tasks-v1.md)。

## 1. 验收矩阵

| AC | 对应任务 | 必须执行的验证 | 当前结果/证据 |
| --- | --- | --- | --- |
| SRS-AC1 | T11-T12、T17-T29、T37 | 活动 Codex 收到复合切换命令；停止确认后仅 Claude Code 获得新 Invocation；WorkItem 不变 | 待执行 |
| SRS-AC2 | T01、T28-T29、T37 | PAUSED 下命令不 queued；切换完成后恢复原阶段并消费既有 queued 消息 | 待执行 |
| SRS-AC3 | T14-T16 | 未授权、离线、Workspace/Capability/Tool 不匹配时，旧调用和偏好均不变 | 待执行 |
| SRS-AC4 | T17-T20、T39 | 停止超时、未知停止、迟到成功、generation 变化；目标 Runtime 不提前启动 | 待执行 |
| SRS-AC5 | T26-T27 | Agent/Skill/Tool/WorkItem/决策/附件/Workspace 保持；无跨 Runtime CLI resume | 待执行 |
| SRS-AC6 | T22、T24-T25、T38 | keep、exclude_previous_once、target_only 的候选顺序和授权边界 | 待执行 |
| SRS-AC7 | T02、T22-T25、T38 | retryable Provider 故障同 Runtime 一次重试后 fallback；认证/合同/权限错误 fail closed | 待执行 |
| SRS-AC8 | T08、T10、T13-T14、T20、T32、T39 | Idempotency-Key、CAS、stale revision、并发请求、事件唯一性 | 待执行 |
| SRS-AC9 | T09-T10、T30-T31、T39 | stopping/applying/resuming 重启恢复；写操作无可信候选不重放 | 待执行 |
| SRS-AC10 | T32-T36 | 首选/活动/备用/阶段展示，刷新和 SSE 重连，桌面/窄屏无重叠 | 待执行 |
| SRS-AC11 | T21、T38 | 管理员 allowed 为上限，Session 显式 preferred 优先于系统默认且不能越权 | 待执行 |
| SRS-AC12 | T03-T10、T32-T43 | 合同、file/PostgreSQL、API、事件、E2E、typecheck、build、Harness | 待执行 |

## 2. 合同检查

- [ ] RuntimePreference 区分 allowed 和 fallback 顺序，旧 Session 有确定兼容规则。
- [ ] RuntimeSwitchRequest 的字段、状态迁移、终态和失败阶段完整。
- [ ] RuntimeAttemptTrace 能区分 initial、manual_switch、retry 和 fallback。
- [ ] ExecutionTermination 明确包含 runtime_switch，不复用 user_paused。
- [ ] API 要求 Idempotency-Key 和 expectedSessionRevision。
- [ ] Event payload 有 switchRequestId/version，事件和 outbox 原子幂等。
- [ ] Data/relational/file 合同与实际迁移一致。
- [ ] UI-State 合同区分 preferredRuntimeType 与 activeRuntimeType。

## 3. 服务端功能检查

- [ ] 确定性解析只捕获明确切换命令，问句和比较不触发。
- [ ] 切换命令在 deferred/queued 判断前处理。
- [ ] 目标 Runtime 完整预检发生在停止旧 Runtime 之前。
- [ ] 预检失败保持当前调用、Session 状态和偏好不变。
- [ ] 停止屏障覆盖 Intent、Brief、Execution 和 Runtime Invocation。
- [ ] stop unconfirmed 时无新 Runtime Invocation。
- [ ] completeRuntimeSwitch 原子更新偏好、revision、generation、请求和事件。
- [ ] 旧 generation 的迟到结果不应用业务输出或 writeback。
- [ ] PAUSED + resumeAfterSwitch 可以安全恢复，不吞 queued FollowUp。
- [ ] 跨 Runtime 不携带旧 cliSessionId。
- [ ] executionCandidate 通过完整校验才复用。
- [ ] Coordinator 策略不再覆盖合法 Session 显式选择。

## 4. fallback 检查

- [ ] keep 允许按有序 fallback 链选择旧 Runtime。
- [ ] exclude_previous_once 只在当前 attemptGroup 排除旧 Runtime。
- [ ] target_only 原子收紧 allowed/preferred/fallback。
- [ ] fallback 候选每次重新校验管理员权限、Workspace 和 Capability。
- [ ] Provider retry/fallback 不突破操作截止、调用次数或 Token 预算。
- [ ] 用户取消、暂停和主动切换不被记录成 Provider fallback。
- [ ] 不可重试错误不自动降级。

## 5. 持久化与故障注入

- [ ] file 模式重启恢复 requested/stopping/stop_confirmed/applying。
- [ ] PostgreSQL 多连接并发只接受一个有效切换请求。
- [ ] 相同 Idempotency-Key 重放不增加停止请求、Invocation、事件或 outbox。
- [ ] stale Session revision 返回 409 且不改变状态。
- [ ] 状态提交后、事件发布前崩溃可由 outbox 补发。
- [ ] stopping 重启只核对停止事实，不重启模型。
- [ ] resuming 写任务无可信候选时等待用户。
- [ ] ACK/SSE 丢失重连后以快照和版本恢复。
- [ ] 持久化失败不会暂时放开 admission。

## 6. 前端检查

- [ ] Runtime 控件显示首选、活动和备用 Runtime。
- [ ] 选择 Runtime、聊天命令和 `/runtime` 使用同一后端状态。
- [ ] preflight、stopping、blocked、resuming、completed、failed 文案准确。
- [ ] 切换中禁止重复切换但保留停止/详情入口。
- [ ] 快照与 SSE 乱序不使版本倒退。
- [ ] 刷新页面不会丢失正在进行的切换。
- [ ] 1440px、1024px、720x900 和常见移动宽度无重叠或文本溢出。
- [ ] 错误卡不泄露凭据、完整命令、本机路径或 Provider 原始响应。

## 7. 预计自动验证

以下命令仅为计划；执行后必须填写实际退出码、用例数、跳过原因和日志路径：

| 命令 | 结果 |
| --- | --- |
| `npm run test -w @agent-cluster/shared` | 待执行 |
| `npm run test -w @agent-cluster/server` | 待执行 |
| `npm run test -w @project/web` | 待执行 |
| `npm run test:e2e:runtime-routing` | 待执行 |
| `npm run test:e2e:cancel` | 待执行 |
| `npm run test:e2e:recovery` | 待执行 |
| `npm run test:e2e:client-presentation` | 待执行 |
| PostgreSQL 隔离故障矩阵 | 待实现/待授权执行 |
| `npm run typecheck` | 待执行 |
| `npm run test:harness` | 待执行 |
| `npm run build` | 待执行 |
| `git diff --check` | 待执行 |

## 8. 必测场景

- [ ] Codex 正在讨论 -> 切换 Claude Code 并继续。
- [ ] Codex 正在写文件 -> 停止确认 -> 可信候选接管。
- [ ] PAUSED 且有 queued 消息 -> 切换并恢复。
- [ ] 目标 Runtime 离线，旧 Runtime 保持运行。
- [ ] 停止超时，目标 Runtime 不启动。
- [ ] 两个并发切换请求竞争。
- [ ] 同一个请求重复提交和 SSE 重放。
- [ ] Claude Code retryable 失败下的三种 fallbackMode。
- [ ] 认证、合同、权限和 Capability 错误不 fallback。
- [ ] 服务分别在 stopping、applying、resuming 崩溃并恢复。
- [ ] 旧 Codex 迟到 completed 不覆盖 Claude Code 新结果。
- [ ] Coordinator 管理员策略与 Session 显式选择冲突。

## 9. 证据记录模板

| 项目 | 需填写 |
| --- | --- |
| 代码版本 | commit、工作区差异标识、source/build 是否一致 |
| 测试环境 | cwd、Node/npm、file/PostgreSQL、独立端口、Runtime fixture |
| AC 与任务 | AC 编号、Task 编号、故障注入点 |
| 调用证据 | switchRequestId、stopRequestId、old/new invocationId、attemptGroupId、generation |
| 结果 | 命令、退出码、通过/失败/跳过数量、日志/截图路径 |
| 清理 | 只清理本次隔离资源；未写真实业务数据、未调用真实模型 |

## 10. 完成检查

- [ ] SRS-AC1 至 SRS-AC12 均有与范围匹配的实际证据。
- [ ] 所有失败和跳过项已解决，或明确阻塞并保持 Spec 状态为未完成。
- [ ] 合同、实现、迁移、事件、UI 和四件套文档一致。
- [ ] 未通过放松停止屏障、扩大 allowlist 或隐藏错误实现通过。
- [ ] 发布、灰度、指标观察和回退步骤经过静态审查。
- [ ] 文档状态仅在上述条件全部满足后改为已完成。
