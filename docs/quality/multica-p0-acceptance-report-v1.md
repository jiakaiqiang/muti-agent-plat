# Multica P0 生产就绪验收报告 v1

> 日期：2026-07-10  
> 当前结论：Codex 本地 CLI/Runtime 标记为可用，P0 仅被其外部模型上游验收阻塞；2026-07-12 新一轮三次 probe 均返回 502；Claude 与 PR-02～PR-04 已通过
> 需求基线：[`../product/multica-refactor-production-readiness-requirements-v1.md`](../product/multica-refactor-production-readiness-requirements-v1.md)

## 1. 状态总览

| 编号 | 验收项 | 结果 | 证据 |
| --- | --- | --- | --- |
| PR-01 | 真实 Codex/Claude CLI | Codex 本地可用/生产验收阻塞 | Claude 全部场景通过；Codex CLI 已安装、登录并能启动 app-server，历史三次 `upstream_400`，2026-07-12 再次三次 probe 均返回上游 502，等待供应商恢复或切换配置 |
| PR-02 | PostgreSQL ActorRef 回填 | 通过 | `npm run test:e2e:actor-ref-postgres-backfill` |
| PR-03 | Redis/BullMQ Autopilot | 通过 | `npm run test:e2e:autopilot-scheduler` |
| PR-04 | Workdir Brief 安全演练 | 通过 | `npm run test:e2e:workdir-brief-safety` |

P0 只有在 PR-01 的 Codex 真实模型验收也通过后才能标记完成。P1 已开始执行：PR-06 已完成，PR-05 的工程实现已完成但真实 20 次采样待执行；详情见 [`multica-p1-acceptance-report-v1.md`](multica-p1-acceptance-report-v1.md)。P0/P1 全部通过后才能形成统一闭环并解锁 P2。

## 2. PR-02 PostgreSQL ActorRef 回填

验收使用一次性 `postgres:16-alpine` 容器和唯一 collection 表，不连接或修改用户生产数据库。

已验证：

- dry-run 统计为 events `scanned=4/skipped=1/filled=3`、tasks `scanned=2/skipped=1/filled=1`，数据库内容不变。
- apply 在单事务内更新 `eventsBySession`、`tasksBySession` 并创建时间戳备份表。
- 已存在的 ActorRef 不被覆盖。
- 第二次 dry-run 的 `filled=0`，证明幂等。
- 使用备份表回滚后，两个 collection 与 apply 前逐对象一致。
- 临时表、备份表和容器在验收结束后清理。

## 3. PR-03 Redis/BullMQ Autopilot

验收使用一次性 `redis:7-alpine` 容器和唯一 `BULLMQ_PREFIX`。

已验证：

- `/api/ops/queues` 返回启用状态、connected 状态和数值型 waiting/active/completed/failed 指标。
- cron scheduler 创建 `scheduled` run，并生成 `origin='autopilot'` 且带 `autopilotRunId` 的 Session。
- 同一 Autopilot 连续手工触发只保留一个 active run，第二次返回 duplicate。
- disable 后 scheduler 被移除，观察超过两个原调度周期未产生新 run。
- 服务在 `AGENT_DISCUSSING` 阶段中断后重启，恢复同一 run 和同一 sessionId，不重复创建 Session。

演练首次发现 BullMQ 模式下 `RecoveryService` 直接跳过全部 Session，导致尚未进入执行队列的 `AGENT_DISCUSSING` 会话无法恢复。已修复为：BullMQ 只接管执行态恢复，brief generation 始终由启动恢复处理。同时增加 `QUEUE_LOCK_DURATION_MS`、`QUEUE_STALLED_INTERVAL_MS` 配置和 stalled 日志。

## 4. PR-04 Workdir Brief

验收在 Windows 一次性工作目录和托管 staging 目录中执行。

已验证：

- 已存在的 AGENTS.md 包含 BOM、中文、CRLF、NUL 和非 UTF-8 字节时，恢复后 Buffer 完全一致。
- 原本不存在的 CLAUDE.md 在恢复后被删除。
- 新服务实例可从 active manifest 完成崩溃恢复；旧 lease 的重复 restore 幂等。
- 同一 workdir 的第二个并发租约返回 `WORKDIR_LEASE_CONFLICT`。
- staging 路径不可用时，用户工作区原文件不发生变化。
- 备份 hash 被破坏时恢复显式失败，并保留 active manifest、lease、备份和现场文件用于排查。
- TTL 只清理 restored staging，不清理 active/failed recovery 证据。

## 5. PR-01 真实 CLI 验收与阻塞记录

本机已确认：

- Codex CLI：`codex-cli 0.144.1`，已登录；本地 CLI、app-server 和 Runtime 注册状态标记为可用。
- Claude Code CLI：`2.1.206`，已登录。
- 验收只使用一次性 workdir，不写入仓库凭据或用户源码。

真实调用脚本默认拒绝运行。本轮已获得成本确认，并在一次性 workdir 进行了两次 Codex 首轮调用及一次最小 app-server probe。三次均在首轮失败，错误为：

```text
MODEL_ERROR / upstream_400
The channel is temporarily unavailable. Please contact the administrator.
```

三次调用都产生了 streaming `runtime_progress`，但 `usage.totalTokens=0`、没有 CLI session id，说明失败发生在模型上游通道，而非本地 app-server 协议、输出 schema 或 Workdir Brief 恢复阶段。第三次最小 probe 仍在约 5.5 秒内得到相同错误；Codex 不再继续重试。

Claude 的真实最小 stream-json 探针已成功返回 `result`、usage 和 session id，并据此修复单回合 stdin 生命周期。生产 adapter 默认在首个 prompt 后关闭 stdin；只有 `CLAUDE_CODE_STREAM_KEEP_STDIN_OPEN=true` 的 control-request 集成保持打开。

修复后，完整验收的前三次真实运行均通过，连续 Resume 使用同一 CLI session；三次 `totalTokens` 分别为 49,779、41,098、41,510。Claude 对非法 Resume 会输出 `result.is_error=true`、无业务 payload 且可能以退出码 0 结束；runner 已将其映射为 `MODEL_ERROR`，RuntimeService 因而产生一次 `RESUME_FALLBACK` 并成功创建新 session。剩余场景验收结果：fallback 新 session 37,091 ms、`totalTokens=49,786`；cancel 1,072 ms 且结果为 `RUNTIME_CANCELLED`；legacy 路径显式 `MODEL_ERROR`，没有静默降级为 mock。所有场景均使用一次性 workdir，并在每轮核验 CLAUDE.md 的原始字节恢复。

供应商恢复或切换为可用 Codex 配置后，使用以下命令续跑：

```powershell
$env:RUN_REAL_CLI_ACCEPTANCE='true'
npm run test:e2e:real-cli-acceptance
```

如只需补跑 Claude 的 fallback/cancel/legacy 场景，可使用：

```powershell
$env:RUN_REAL_CLI_ACCEPTANCE='true'
$env:REAL_CLI_RUNTIME='claude_code'
$env:REAL_CLI_PHASE='remaining'
npm run test:e2e:real-cli-acceptance
```

Codex 上游恢复后，建议先执行最小探针再执行完整验收：

```powershell
$env:RUN_REAL_CLI_ACCEPTANCE='true'
$env:REAL_CLI_RUNTIME='codex'
$env:REAL_CLI_PHASE='probe'
npm run test:e2e:real-cli-acceptance
```

### 2026-07-12 Codex 补验记录

- 真实验收脚本已迁移到 v2-only `InvocationPlan`、`ResolvedExecutionTarget`、`ContextEnvelopeV2` 和 Workspace binding 合同；server typecheck 与脚本语法检查通过。
- 使用当前 custom provider、`gpt-5.6-sol` 和 Responses API 连续执行三次最小 probe。
- 三次分别运行 60,647 ms、54,721 ms、57,421 ms；每次 CLI 内部均完成 5 次断线重试，最终由 `https://cn.picpi.top/v1/responses` 返回 `502 Bad Gateway`。
- 三次均产生 runtime progress 和 stream metrics，但 `totalTokens=0`、无 CLI session id；失败仍发生在模型网关，未进入输出解析或 Resume 验收。
- 按“三次失败后暂停”规则停止继续调用；恢复条件为供应商确认通道可用，或提供经过验证的新 provider/model 配置。
- 脱敏报告保存在 `.cache/agent-cluster/codex-probe-2026-07-12.json`、`codex-probe-attempt-2-2026-07-12.json` 和 `codex-probe-attempt-3-2026-07-12.json`。

### 2026-07-12 v2 Resume 验收链收口

- 审计发现真实验收脚本虽仍构造旧 `options.resume`，但 v2 `InvocationPlan` 会忽略该字段，导致 Resume/fallback 断言实际不可达。
- shared 合同新增窄类型 `InvocationPlan.resume`；Orchestrator 只从同一 `sessionId/agentId/taskId/runtimeType` 的最近 completed invocation 构造恢复请求。
- Codex 映射到 app-server `thread/resume`，Claude 映射到原生 `--resume`；workdir 只由 Workspace binding 决定，恢复请求中的 workdir 仅用于一致性校验。
- RuntimeService 在 Resume 失败或返回不同 session id 时移除恢复请求并重试一次，产生唯一 `RESUME_FALLBACK`；cancel 和第二次失败不会递归重试。
- 已补 Resume 成功、session id 不一致、单次 fallback、原生参数映射、workdir 不匹配和 prior invocation 作用域测试；真实 CLI 脚本已改为实际写入 `InvocationPlan.resume`。

脚本覆盖各 Runtime 至少 3 次真实运行、同 session Resume、失效 session fallback、cancel、usage、CLI sessionId、workdir、事件流、runtime invocation、legacy 显式失败和用户说明文件逐字节恢复。执行过程中会写入脱敏进度文件 `.cache/agent-cluster/real-cli-acceptance-status.json`（也可通过 `REAL_CLI_ACCEPTANCE_REPORT_PATH` 指定），便于发生通道中断时审计。

## 6. 当前验证命令

```text
npm run test:e2e:actor-ref-postgres-backfill  PASS
npm run test:e2e:autopilot-scheduler          PASS
npm run test:e2e:workdir-brief-safety         PASS
node --import tsx --test apps/server/src/modules/recovery/recovery.service.spec.ts  4/4 PASS
node --import tsx --test Claude parser + runner specs  16/16 PASS
npm run test:e2e:claude-streaming             PASS
npm run typecheck                             PASS
node --check tests/e2e/real-cli-acceptance.mjs PASS
```

2026-07-12 v2 Resume 收口后再次执行完整质量门：`npm run typecheck` 通过；`npm run test` 为 server 733 pass / 1 skip、Web 68/68；`npm run test:harness` 的 Phase 1～5、v2-only domain/runtime 全部通过；全 workspace build 通过；真实 CLI 验收脚本语法检查通过。P0 当前剩余阻断仅是 Codex 真实上游验收，不是本地质量门失败。
