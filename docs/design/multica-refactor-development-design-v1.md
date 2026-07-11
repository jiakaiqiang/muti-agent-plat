# Multica 对标改造·开发设计文档 v1

> 更新时间：2026-07-09
> 状态：待评审
> 输入文档：
> - [`docs/analysis/multica-runtime-comparison-v1.md`](../analysis/multica-runtime-comparison-v1.md)（运行时执行层对比）
> - [`docs/analysis/agent-cluster-vs-multica-architecture-v1.md`](../analysis/agent-cluster-vs-multica-architecture-v1.md)（全景架构对比）
> - [`docs/analysis/multica-actionable-refactor-plan-v1.md`](../analysis/multica-actionable-refactor-plan-v1.md)（R1–R7 改造清单）
> 本文职责：把 R1–R7 从"方案"落到"可实施设计"——接口、时序、数据、文件变更清单、分期与验证矩阵。实现代码不在本文范围。

---

## 1. 设计原则与不变量

### 1.1 不动的（护城河清单）

以下现有设计经对比评估为优势项，本次改造**明确不动**：

| 不变量 | 位置 | 理由 |
| --- | --- | --- |
| 合同先行 + 合同测试 | `packages/shared/src/contracts.ts`、`docs/contracts/` | 跨栈唯一事实源，改造本身也走"先改合同再改实现" |
| 强类型事件流 + 语义/渲染分离 | `CollaborationEventType`（37 类）+ `EventRenderType` | 三视图共用事实源，类型安全是重构护栏 |
| Task Brief + 用户确认闭环 | `brief_*` / `user_confirmation_*` 事件对 | 防 AI 乱来防线，multica 缺失项 |
| requestedContext 反幻觉协议 | `RuntimeContextRequest` + 补充上下文重派流程 | 已有完整 e2e 覆盖 |
| 意图识别前置 | `modules/intent-recognition/` | 优于 multica 的 @agent 直触发 |
| Runtime 可插拔抽象 | `AgentRuntimeAdapter` + `RuntimeRegistryService` | 抽象边界正确，本次只改 adapter 内部 |
| Mock runtime + e2e 冒烟文化 | `tests/e2e/`（68 个）、`LLM_MOCK_FALLBACK` 显式开关 | 改造的每一期都靠它验证 |

### 1.2 改造的核心判断

执行层向 multica 对齐：**结构化信息的义务从"模型输出"移到"CLI 协议帧解析"**。`RuntimeOutput` 合同保持不变，变的是它的生产方式——从"prompt 要求模型吐 JSON + 千行归一化打捞"变为"解析器从协议帧确定性构造"。

### 1.3 关键事实修正（相对 refactor plan）

持久化层是 **JSONB collection**（`persistence.service.ts:113`，单表 `agent_cluster_collections`，key → jsonb value），不是关系表。因此 R3/R4 的"ALTER TABLE 加列"修正为：**共享合同加字段 + JSONB 文档自然持久化 + 一次性回填脚本**，无 SQL migration。

---

## 2. 总体架构变化

```text
现状（执行黑盒）：
orchestrator.service.ts:3975
  └─ runtime.run(input, signal)          ← 唯一调用点
       └─ adapter: execFile(CLI) ─────── 等进程退出
            └─ JSON.parse(stdout) ────── 猜模型输出
  合成心跳 :3959 setInterval ──────────── 假 runtime_progress

目标（流式白盒）：
orchestrator
  ├─ runtime.run(input, signal) ───────── 语义不变，仍返回 AgentRunResult
  └─ adapter.stream?(runId) ───────────── 并发消费真实帧（合同已预留的钩子）
       └─ adapter: spawn(CLI, 流式协议)
            ├─ 每帧 → AgentRuntimeEvent → 实时事件
            ├─ result 帧 → RuntimeOutput（确定性构造）
            └─ 帧到达时间 → 活性看门狗（替代 wall-clock 超时）
  合成心跳降级为 fallback（adapter 无 stream 时才启用）
```

模块依赖方向不变：orchestrator → runtimes；事件写入仍由 orchestrator 完成（消费 stream 后调 `events.create`），runtimes 模块不反向依赖 events。

---

## 3. R1 详设：CLI adapter 原生流式协议

### 3.1 合同基础（零破坏）

`contracts.ts:1066` 的 `AgentRuntimeAdapter` 已预留：

```ts
stream?: (runId: UUID) => AsyncIterable<AgentRuntimeEvent>;
cancel?: (runId: UUID) => Promise<void>;
```

`AgentRuntimeEvent`（:932）已有 `runtime_progress / tool_called / tool_completed / artifact_created` 类型。**R1 不改合同类型，只是让 codex/claude 两个 adapter 真正实现这两个可选方法。** `docs/contracts/runtime-contract-v0.1.md` 第 3 节补充"流式语义"说明即可，版本仍为 v0.1。

### 3.2 新增内部结构（runtimes 模块内，不进合同）

```text
apps/server/src/modules/runtimes/
  streaming/
    runtime-stream-frame.ts        # 统一帧类型（内部）
    claude-stream-parser.ts        # stream-json 逐行 → 帧
    codex-appserver-client.ts      # JSON-RPC 2.0 双向通道 → 帧
    frame-to-output.mapper.ts      # result 帧 → RuntimeOutput（按 expectedOutput.kind）
    run-channel.ts                 # per-runId 帧通道，支撑 stream?(runId)
    liveness-watchdog.ts           # R2 看门狗（见第 4 节）
```

统一帧类型（内部归一化目标，两个 CLI 的解析器都映射到它）：

```ts
type RuntimeStreamFrame =
  | { kind: 'assistant_text'; text: string }
  | { kind: 'tool_use'; tool: string; input: unknown }
  | { kind: 'tool_result'; tool: string; output: string; isError?: boolean }
  | { kind: 'result'; payload: unknown; usage?: RawUsage; cliSessionId?: string }
  | { kind: 'system'; subtype: string; raw: unknown }
  | { kind: 'stderr_tail'; text: string };
```

### 3.3 Claude 通道

替换 `claude-code-runtime-adapter.service.ts` 的执行核（现状 L47 一次性 `execFileAsync`）：

```text
spawn claude -p --output-format stream-json --input-format stream-json
        --verbose --strict-mcp-config --permission-mode bypassPermissions
        [--model X --max-turns N --append-system-prompt S --resume <id>]
```

要点（对齐 multica `claude.go` 的经验，全部为本项目要处理的坑）：

1. prompt 通过 stdin 写 JSON 帧；**stdin 写与 stdout 读必须在独立异步任务**，防死锁；stdin 保持打开以应答 `control_request` 双向帧。
2. stdout 逐行 `JSON.parse`——每行是 CLI 保证的合法 JSON，解析失败按 `system` 帧降级记录，不再需要 `jsonTextCandidates` 式修复。
3. stderr 收进有界 tail buffer（如 8KB 环形），失败时随 `RuntimeError.details` 上报。
4. `result` 帧携带 `session_id` 与 usage → 写入 `RuntimeInvocationLog`（为 R4 铺路）。
5. `--resume` 未接上（CLI 返回新 session 且失败）→ 走"新会话重试"回退（R4 语义，R1 先留接口）。

### 3.4 Codex 通道

替换 `codex-runtime-adapter.service.ts` 执行核（现状 L49 `execFileAsync` + L149 `exec --json`）：

- `spawn codex app-server` 长驻进程 + stdio JSON-RPC 2.0 双向通信；一个 adapter 实例管理一个（或按并发数扩展的）app-server 进程池。
- 请求/通知映射到 `RuntimeStreamFrame`；token 用量从 result 事件解析。
- 进程崩溃 → 自动重启进程 + 当次 run 判 `MODEL_ERROR`（retryable），不影响后续 run。

### 3.5 输出构造（替代"猜 JSON"）

`frame-to-output.mapper.ts` 按 `expectedOutput.kind` 从 `result` 帧构造 `RuntimeOutput`：

| expectedOutput.kind | 构造来源 |
| --- | --- |
| `agent_message` | result 帧文本 → `content`（纯文本，无需再防嵌套对象） |
| `task_execution_result` | result 帧 payload + 累计的 `tool_use/tool_result` 帧推导 `changedArtifacts` |
| 其余 kind | result 帧 payload 字段映射；缺字段按合同默认值补齐 |

**删除项**：两个 CLI adapter 的 prompt 中 `'Return one JSON object and no markdown fences.'`（codex L170、claude L140）及各自的 `JSON.parse(stdout)` 打捞链（codex L212–219、claude L213–214）。`generic-llm-runtime.service.ts` 的归一化防御**保留**（raw LLM API 仍需要）。

### 3.6 事件桥接与时序

```text
orchestrator (runRuntime 处，:3959–:3986 改造)
  1. const runPromise = runtime.run(input, signal)
  2. adapter.stream 存在 → for await frame-events → events.create(真实 runtime_progress/tool_called/...)
     adapter.stream 不存在 → 保留现有合成心跳（mock/generic_llm 路径不变）
  3. await runPromise → 现有 recordTokenUsage / 后续流程完全不变
```

`run-channel.ts` 负责 per-runId 通道：`run()` 内部产帧 → push 通道；`stream(runId)` 消费；run 结束关闭通道。通道有界（如 512 帧），满则丢弃中间 `assistant_text` 增量、保留 tool/result 帧，防内存膨胀。

### 3.7 错误与状态映射

| 进程/协议情况 | RuntimeError.code | retryable |
| --- | --- | --- |
| 首帧超时（R2） | `RUNTIME_TIMEOUT` | true |
| idle 超时（R2） | `RUNTIME_TIMEOUT` | true |
| 用户取消（AbortSignal） | `RUNTIME_CANCELLED` | false |
| 进程非零退出且无 result 帧 | `MODEL_ERROR`（stderr tail 入 details） | true |
| result 帧无法映射 expectedOutput.kind | `OUTPUT_SCHEMA_INVALID`（应极少发生，发生即 mapper bug） | false |
| CLI 不存在/不可执行 | `CAPABILITY_BLOCKED`（由 `checkAvailability` 前置拦截） | false |

### 3.8 灰度开关

```text
ENGINEERING_RUNTIME_STREAMING = off | codex | all   # 默认 off
```

- `off`：走旧 exec 路径（保留至 M5 清理）。
- `codex`：仅 codex adapter 启用流式（先灰度协议更清晰的一侧）。
- `all`：codex + claude 全量。
- mock / generic_llm / code_reader / test_runner 不受此开关影响。

### 3.9 文件变更清单（R1）

| 文件 | 变更 |
| --- | --- |
| `runtimes/streaming/*`（新增 6 文件） | 帧类型、双解析器、mapper、通道、看门狗 |
| `codex-runtime-adapter.service.ts` | 执行核替换为 app-server 通道；实现 `stream`/`cancel` |
| `claude-code-runtime-adapter.service.ts` | 执行核替换为 stream-json 通道；实现 `stream`/`cancel` |
| `runtime.service.ts` | `RuntimeInvocationLog` 增加 `cliSessionId?/workDir?` 字段记录 |
| `orchestrator.service.ts`（:3959–:3986） | 心跳改为 fallback；并发消费 stream 写事件 |
| `common/runtime-config.ts` | 新增流式/看门狗配置读取 |
| `docs/contracts/runtime-contract-v0.1.md` | 第 3 节补流式语义与帧→事件映射说明 |
| `tests/e2e/codex-runtime-stub-smoke.mjs`、`claude-code-runtime-stub-smoke.mjs` | stub 升级为可产协议帧的假 CLI |

### 3.10 验收（R1）

1. stub e2e：假 CLI 输出含长中文 + 代码块 + 裸换行的帧序列 → 不触发 `OUTPUT_SCHEMA_INVALID`。
2. 执行期间产生 ≥3 条真实 `runtime_progress`/`tool_called` 事件（非 RUNTIME_HEARTBEAT）。
3. `usage.totalTokens > 0`（从 result 帧解析）。
4. `ENGINEERING_RUNTIME_STREAMING=off` 时行为与现状完全一致（回归保障）。
5. 用户取消：stream 中途 abort → 进程被杀、事件流终止于 `runtime_failed`、状态 `cancelled`。

---

## 4. R2 详设：活性看门狗

### 4.1 状态机

```text
spawn ──┬─ 首帧未到且 t > FIRST_FRAME_TIMEOUT ────────→ kill, RUNTIME_TIMEOUT(首帧超时)
        └─ 首帧到达 → RUNNING
RUNNING ─┬─ 每帧到达 → lastFrameAt = now
         ├─ now - lastFrameAt > IDLE_TIMEOUT ─────────→ kill, RUNTIME_TIMEOUT(idle)
         ├─ ABSOLUTE_TIMEOUT > 0 且 t > 绝对上限 ──────→ kill, RUNTIME_TIMEOUT(absolute)
         └─ result 帧 → DONE（看门狗停止）
```

判活以 **帧到达** 为准（`assistant_text` 增量也算活），不区分帧语义——语义级无进展（如模型复读）由 `max-turns`/budget 兜底，不在看门狗职责内。

### 4.2 配置

| 环境变量 | 默认 | 语义 |
| --- | --- | --- |
| `CODEX_RUNTIME_FIRST_FRAME_TIMEOUT_MS` / `CLAUDE_CODE_FIRST_FRAME_TIMEOUT_MS` | 30000 | 首帧死线，快速识别"根本没起来" |
| `CODEX_RUNTIME_IDLE_TIMEOUT_MS` / `CLAUDE_CODE_IDLE_TIMEOUT_MS` | 600000 | 连续无帧上限（对齐 multica Codex 语义超时 10min） |
| `CODEX_RUNTIME_TIMEOUT_MS` / `CLAUDE_CODE_TIMEOUT_MS`（现有） | **语义变更**：0 或未设 = 无绝对上限；>0 = 绝对上限 | 兼容既有部署；本地慢模型场景显式设 0 或不设 |

现状默认 `?? 120_000`（两 adapter L42）**移除**——这是 memory `agent-freeze-root-cause-2026-07` 记录的误杀根因。旧 exec 路径（灰度 off）保留原语义不动。

### 4.3 验收（R2）

1. stub e2e：帧间隔 45s × 4 帧（总时长 >120s）→ 正常完成，不再被 120s 杀。
2. stub e2e：首帧后停发 → 在 IDLE_TIMEOUT 处被杀，`error.details.watchdog = 'idle'`。
3. stub e2e：不发任何帧 → FIRST_FRAME_TIMEOUT 处快速失败。

---

## 5. R3 详设：ActorRef 一等公民

### 5.1 合同变更（contracts.ts，v0.1 → v0.2）

```ts
export type ActorType = 'user' | 'agent' | 'system';
export type ActorRef = { type: ActorType; id: UUID };
```

分两步走，**双写过渡**：

- **v0.2（M3）**：`CollaborationEvent` 增加 `actor?: ActorRef`；`fromAgentId`（:328）标记 `@deprecated` 但继续写。`AgentTask` 的 `assigneeAgentId`/`assignedByAgentId`（:413–414）同法增加 `assignee?: ActorRef` / `assignedBy?: ActorRef`。
- **v0.3（M5）**：删除 deprecated 字段，消费端全部读 ActorRef。

### 5.2 写入收敛与回填

- 写入收敛点：`events.service.ts` 的 `create()` 是事件唯一写入口——在此统一推导：调用方传了 `actor` 用之；只传 `fromAgentId` 则推导 `{type:'agent', id}`；`user_message` 类型推导 `{type:'user'}`；系统事件推导 `{type:'system'}`。**上游调用点（orchestrator 数十处）在过渡期零改动。**
- 回填：一次性脚本遍历 JSONB collection 中历史事件/任务，按同规则补 `actor`。脚本放 `scripts/backfill-actor-ref.mjs`，幂等（已有 actor 跳过）。
- 前端：`ChatTimeline.vue` 等改读 `event.actor`，读不到回退旧字段（过渡期兼容）。

### 5.3 验收（R3）

1. 合同测试：所有事件 fixture 校验 `actor` 存在且与旧字段一致。
2. 回填脚本跑两遍结果一致（幂等）。
3. 前端 timeline 在纯 actor 数据与纯旧字段数据下渲染一致。

---

## 6. R4 概设：Session Resumption（依赖 R1）

- **数据**：`RuntimeInvocationLog` 增加 `cliSessionId?: string; workDir?: string`（R1 已写入）；`AgentTask` 增加同名可选字段。JSONB 持久化自动生效，无 migration。
- **派发**：orchestrator 派发 `task_execution` 前，查同 `(agentId, taskId)`（跨 session 复用则放宽为 `(agentId, sessionId)`，首期取窄口径）最近一条 `completed` invocation 的 `cliSessionId/workDir`，写入 `AgentRunInput.options.resume = { cliSessionId, workDir }`。
- **adapter**：claude 加 `--resume <id>`；codex 走 app-server thread resume。**resume 失败（CLI 报错或返回新 session）→ 自动降级新会话重试一次**，事件流记 `runtime_progress`（`code: 'RESUME_FALLBACK'`）。
- **验收**：stub e2e 同任务二次派发时收到 resume 参数；resume 失败路径降级成功且有事件留痕。

## 7. R5 概设：workdir brief 注入（依赖 R1）

- 新增 `runtimes/streaming/workdir-brief.service.ts`：任务启动前把 ContextPack 稳定部分（agent instructions、约束、技能清单）写入 workdir 的 `CLAUDE.md`/`AGENTS.md`，任务上下文写 `.agent_context/`；prompt 只留任务本身。
- **安全边界（本期收窄）**：首期仅对**任务级临时目录**启用（`~/.agent-cluster/workspaces/<session>/<task>/`）；`server_local` 指向用户真实目录时**不写入**、维持现状纯读——multica 的"逐字节还原用户目录"机制推迟到独立评审后再做。
- **验收**：stub e2e 断言 workdir 存在 brief 文件且 prompt 长度显著下降；任务结束临时目录按保留策略清理。

## 8. R6 概设：Skill 极简通道（独立）

- 合同：`Skill { id, name, description, content, files? }` + Agent 侧 `skillIds: UUID[]`；存 JSONB collection（`skills`），无 migration。
- 注入：ContextPack 组装时并入 `systemRules`；R5 落地后改写 `workdir/.claude/skills/<name>/SKILL.md` 让 CLI 自读。
- API：`modules/capabilities/` 下增 skill CRUD + agent 绑定两个端点，同步 `docs/contracts/api-contract-v0.1.md`。

## 9. R7 展望：Autopilot（依赖 R3 的 system actor）

按 refactor plan 第 R7 节执行，前置条件：R3 落地（`system` 发起者）、BullMQ repeatable job、issueguard 去重。本文不展开，实施前出独立专题设计。

---

## 10. 分期交付与验证矩阵

| 里程碑 | 内容 | 定向验证 | 通用验证 |
| --- | --- | --- | --- |
| M1 | R1-codex + R2 + 灰度开关 | `codex-runtime-stub-smoke`（升级版）、看门狗 3 用例 | `typecheck / test / test:harness / build` |
| M2 | R1-claude | `claude-code-runtime-stub-smoke`（升级版）+ M1 全量回归 | 同上 |
| M3 | R3 双写 + 回填脚本 | 合同测试、回填幂等、timeline 双数据源渲染 | 同上 + `run-main-chain` |
| M4 | R4 + R5（临时 workdir）+ R6 | resume stub e2e、workdir brief e2e、skill 注入 e2e | 同上 |
| M5 | R7 + v0.3 清理（删 deprecated 字段、删旧 exec 路径、灰度开关默认 all） | autopilot 专题验收 | 全量 e2e |

每个里程碑独立分支、独立 PR；M1/M2 期间 `ENGINEERING_RUNTIME_STREAMING` 默认保持 `off`，e2e 显式开启验证新路径，生产路径零风险。

## 11. 风险与回滚

| 风险 | 缓解 | 回滚 |
| --- | --- | --- |
| stream-json / app-server 协议与本机 CLI 版本不匹配 | `checkAvailability` 增加协议探测（`claude --version` / app-server handshake），不匹配自动降级旧路径并事件留痕 | 开关切 `off`，单次部署内完成 |
| 通道内存膨胀（长任务万帧） | 有界通道 + 中间文本帧丢弃策略（3.6） | 无需回滚，行为退化为少量进度事件 |
| ActorRef 双写不一致 | 写入收敛在 `events.create` 单点 + 合同测试断言一致性 | v0.2 期间旧字段始终可用，前端回退读旧字段 |
| resume 到污染的 session | 降级新会话重试 +事件留痕；resume 只在上次 `completed` 时启用（failed/cancelled 不 resume） | 关闭 resume（options 不传即旧行为） |
| workdir 写入触碰用户文件 | 首期只写任务级临时目录，用户真实目录纯读 | 功能开关级回滚 |

## 12. 文档同步清单

| 文档 | 时机 | 变更 |
| --- | --- | --- |
| `docs/contracts/runtime-contract-v0.1.md` | M1 前 | 流式语义、看门狗语义、超时变量语义变更 |
| `docs/contracts/event-contract-v0.1.md` | M3 前 | `actor` 字段、双写与弃用计划 |
| `docs/contracts/api-contract-v0.1.md` | M4 前 | skill CRUD 端点 |
| `docs/analysis/feature-inventory-and-status-v1.md` | 每期后 | 功能状态推进 |
| `docs/ai-agent-context/project-map.md` | M1 后 | `runtimes/streaming/` 路径入图 |
