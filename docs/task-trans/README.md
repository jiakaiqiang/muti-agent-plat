# Multica 对标改造·任务清单

> 更新时间：2026-07-10
> 当前状态：M1～M4 全部完成；R7 Autopilot 已作为独立功能门控模块完成；真实外部环境验收待执行。
> 上游设计：[`docs/design/multica-refactor-development-design-v1.md`](../design/multica-refactor-development-design-v1.md)
> 拆分粒度：每个任务 10–15 分钟一个 TDD 循环。
> 顺序：**严格前后依赖**——任务 N+1 只能在任务 N 全部验收通过后开始。
> TDD 原则：每个任务先写测试（红）→ 实现让测试通过（绿）→ 可选重构 → 提交。禁止跳过红步。

## 当前任务状态

| 里程碑 | 任务数 | 状态 | 验收结论 |
| --- | ---: | --- | --- |
| M1 · Codex Streaming + Watchdog | 17 | ✅ 已完成 | Codex app-server JSONL、RunHandle、watchdog、灰度与 legacy 回归通过 |
| M2 · Claude Streaming | 6 | ✅ 已完成 | Claude stream-json、control request、取消、usage 与 `all` 灰度通过 |
| M3 · ActorRef v0.2 | 7 | ✅ 已完成 | Event/Task 双写、前端兼容、file/PostgreSQL collection 回填测试通过 |
| M4 · Resume + Workdir Brief + Skill | 12 | ✅ 已完成 | Resume/fallback、可恢复 brief、Skill CRUD/注入及三个专项 e2e 通过 |
| R7 · Autopilot | 独立实现 | ✅ 已完成（功能门控） | CRUD、手工触发、issueguard、session 追踪 e2e 通过；scheduler 待真实 Redis 验收 |

状态口径：

- 本页为 `docs/task-trans/` 的当前状态权威入口。
- 各任务文件中的未勾选框是最初“一任务一分支、一任务一提交”的增量执行模板；本轮因用户未授权 commit/PR，采用合并实施和统一验收，不追溯伪造提交证据。
- 自动化已证明受控本地实现完成；真实 Codex/Claude 凭据、PostgreSQL `--apply`、Redis scheduler 仍标记为部署环境验收项。

## 通用工作流（原计划模板）

1. **拉最新** `git pull` + 确认无未提交改动
2. **打分支** `git checkout -b task/<id>-<slug>`（示例：`task/M1-03-run-channel`）
3. **读任务** 阅读本任务 md，尤其"验收目标"
4. **红**：按"测试步骤"写测试文件；执行确认失败
5. **绿**：按"实现要点"写最小实现；执行确认通过
6. **门禁**：跑本任务指定的验证命令，全绿
7. **提交** `git commit -m "task(<id>): <one-line>"`；发 PR 关联本 md
8. **合入后**才能开始下一任务

## 任务矩阵

### M1 · Codex 流式协议 + 活性看门狗（17 个）

| ID | 目标 | 依赖 |
|---|---|---|
| [M1-01](./M1-01-runtime-contract-streaming-semantics.md) | 补 runtime-contract 流式语义章节 | — |
| [M1-02](./M1-02-runtime-stream-frame-type.md) | 内部帧类型 `RuntimeStreamFrame` | M1-01 |
| [M1-03](./M1-03-run-channel-tdd.md) | `RunChannel` 有界通道 TDD | M1-02 |
| [M1-04](./M1-04-liveness-watchdog-first-frame.md) | 看门狗：首帧超时 TDD | M1-03 |
| [M1-05](./M1-05-liveness-watchdog-idle.md) | 看门狗：idle 超时 TDD | M1-04 |
| [M1-06](./M1-06-liveness-watchdog-absolute-cancel.md) | 看门狗：绝对超时 + cancel TDD | M1-05 |
| [M1-07](./M1-07-codex-jsonrpc-codec.md) | Codex JSON-RPC 2.0 编解码器 TDD | M1-02 |
| [M1-08](./M1-08-codex-frame-parser.md) | Codex 事件 → `RuntimeStreamFrame` 解析器 TDD | M1-07 |
| [M1-09](./M1-09-frame-to-output-agent-message.md) | 帧 → `agent_message` mapper TDD | M1-02 |
| [M1-10](./M1-10-frame-to-output-execution-result.md) | 帧 → `task_execution_result` mapper TDD | M1-09 |
| [M1-11](./M1-11-codex-stub-cli-upgrade.md) | 升级 codex-runtime-stub 假 CLI 可产帧 | M1-08 |
| [M1-12](./M1-12-codex-adapter-spawn-appserver.md) | CodexAdapter 换成 spawn app-server | M1-11 |
| [M1-13](./M1-13-codex-adapter-stream-cancel.md) | CodexAdapter 实现 `stream/cancel` | M1-12 |
| [M1-14](./M1-14-streaming-feature-flag.md) | 灰度开关 `ENGINEERING_RUNTIME_STREAMING` | M1-13 |
| [M1-15](./M1-15-orchestrator-consume-stream.md) | orchestrator 消费 stream 写真事件 | M1-14 |
| [M1-16](./M1-16-orchestrator-heartbeat-fallback.md) | orchestrator 心跳降级为 fallback | M1-15 |
| [M1-17](./M1-17-m1-regression.md) | M1 e2e 全量回归 + typecheck + build | M1-16 |

### M2 · Claude 流式协议（6 个）

| ID | 目标 | 依赖 |
|---|---|---|
| [M2-01](./M2-01-claude-stream-json-parser.md) | Claude stream-json 帧解析器 TDD | M1-17 |
| [M2-02](./M2-02-claude-control-request.md) | Claude `control_request` 双向帧 TDD | M2-01 |
| [M2-03](./M2-03-claude-stub-cli-upgrade.md) | 升级 claude-code-runtime-stub 假 CLI 可产帧 | M2-02 |
| [M2-04](./M2-04-claude-adapter-spawn.md) | ClaudeAdapter 换成 spawn stream-json | M2-03 |
| [M2-05](./M2-05-claude-adapter-stream-cancel.md) | ClaudeAdapter 实现 `stream/cancel` | M2-04 |
| [M2-06](./M2-06-m2-flag-all-regression.md) | 灰度扩至 `all` + M2 回归 | M2-05 |

### M3 · ActorRef 一等公民（7 个）

| ID | 目标 | 依赖 |
|---|---|---|
| [M3-01](./M3-01-event-contract-v02-doc.md) | event-contract v0.2 双写迁移文档 | M2-06 |
| [M3-02](./M3-02-actor-type-and-event-actor.md) | 定义 `ActorRef` + `CollaborationEvent.actor` | M3-01 |
| [M3-03](./M3-03-agent-task-assignee-actor.md) | `AgentTask.assignee/assignedBy` 双写字段 | M3-02 |
| [M3-04](./M3-04-events-create-actor-derive.md) | `events.service.create` 单点推导 actor TDD | M3-03 |
| [M3-05](./M3-05-actor-backfill-script.md) | 回填脚本 `backfill-actor-ref.mjs` 幂等 TDD | M3-04 |
| [M3-06](./M3-06-web-timeline-actor-render.md) | 前端 ChatTimeline 双数据源渲染兼容 | M3-05 |
| [M3-07](./M3-07-m3-contract-tests-regression.md) | M3 合同测试全量 + e2e 回归 | M3-06 |

### M4 · Session Resumption + workdir brief + Skill（12 个）

| ID | 目标 | 依赖 |
|---|---|---|
| [M4-01](./M4-01-invocation-log-cli-session-fields.md) | `RuntimeInvocationLog` 加 `cliSessionId/workDir` | M3-07 |
| [M4-02](./M4-02-orchestrator-lookup-prior-invocation.md) | orchestrator 查上一条 completed invocation TDD | M4-01 |
| [M4-03](./M4-03-run-input-options-resume.md) | `AgentRunInput.options.resume` 透传 TDD | M4-02 |
| [M4-04](./M4-04-codex-adapter-consume-resume.md) | CodexAdapter 消费 resume 参数 | M4-03 |
| [M4-05](./M4-05-claude-adapter-consume-resume.md) | ClaudeAdapter 消费 `--resume` | M4-04 |
| [M4-06](./M4-06-resume-fallback-new-session.md) | resume 失败降级 + 事件留痕 TDD | M4-05 |
| [M4-07](./M4-07-workdir-brief-service-scaffold.md) | 新增 `WorkdirBriefService`（临时目录 only） | M4-06 |
| [M4-08](./M4-08-workdir-brief-write-files.md) | brief 写入 CLAUDE.md/AGENTS.md TDD | M4-07 |
| [M4-09](./M4-09-adapter-prompt-slim.md) | adapter prompt 减重集成 TDD | M4-08 |
| [M4-10](./M4-10-skill-contract-and-storage.md) | Skill 合同 + Agent.skillIds + JSONB 存储 | M4-09 |
| [M4-11](./M4-11-skill-crud-and-injection.md) | Skill CRUD + ContextPack 注入 TDD | M4-10 |
| [M4-12](./M4-12-m4-regression.md) | M4 全量回归 + 文档同步 | M4-11 |

**R7 Autopilot 不在 M1～M4 的原始拆分清单内**；当前已按补全系统设计作为独立功能门控模块实现，默认禁用并强制 `mock/low-risk`。

## 全局验收（每期结束）

- `npm run typecheck`
- `npm run test`
- `npm run test:harness`
- `npm run build`
- 灰度开关默认值本期保持不变（M1/M2 期间 `ENGINEERING_RUNTIME_STREAMING=off`，M2-06 后可切 `all`）

## 常见错误约定

- ❌ 不允许跳过"红步"直接写实现——PR 里必须能看到测试先失败的证据（截图或 commit log）
- ❌ 不允许"顺手改邻近代码"——每个任务只动 md 里列出的文件
- ❌ 不允许合并任务——就算你 5 分钟能干完两个也要分两个 PR
- ✅ 允许一个任务发现依赖任务有缺陷时**回退到上一任务补测试**，但必须先合入补丁再继续
