# Multica 对标改造补全系统设计 v1

> 日期：2026-07-10  
> 状态：已实现（受控环境验证完成）  
> 执行计划：[`../roadmap/multica-refactor-completion-execution-plan-v1.md`](../roadmap/multica-refactor-completion-execution-plan-v1.md)  
> 上游设计：[`multica-refactor-development-design-v1.md`](./multica-refactor-development-design-v1.md)

## 1. 设计目标

本设计定义 R1～R7 补全实施后的目标架构，重点解决：

- CLI Runtime 流式执行的启动、事件、取消、超时和结果之间缺少统一生命周期。
- CLI session 元数据依赖事件 metadata 猜测，无法可靠恢复。
- ActorRef 仅停留在合同层，任务写入和历史数据尚未完成双写迁移。
- ContextPack 通过巨型 prompt 注入，未利用 CLI 的工作目录说明文件。
- Skill、Autopilot 缺少最小可治理通道。

## 2. 总体架构

```text
Sessions / Execution / BullMQ
            |
            v
       Orchestrator
            |
            +---- Context Router ---- Memory / RAG / Skill
            |
            v
       RuntimeService
            |
      +-----+-----------------------+
      |                             |
 legacy adapter.run()       streaming adapter.start()
      |                             |
      |                  AgentRuntimeRunHandle
      |                  |- events AsyncIterable
      |                  |- result Promise
      |                  `- cancel()
      |                             |
      +-------------+---------------+
                    v
         Collaboration Events
         Runtime Invocation Log
         Artifacts / Usage / SessionRef
```

## 3. Runtime 生命周期

### 3.1 统一 RunHandle

Streaming adapter 必须同步返回运行句柄，避免 `run()` 已开始但 `stream(runId)` 尚未注册或已经结束的竞态。

```ts
export interface AgentRuntimeRunHandle {
  events: AsyncIterable<AgentRuntimeEvent>;
  result: Promise<AgentRunResult>;
  cancel(): Promise<void>;
}

export interface AgentRuntimeAdapter {
  run(input: AgentRunInput, signal?: AbortSignal): Promise<AgentRunResult>;
  start?(input: AgentRunInput, signal?: AbortSignal): AgentRuntimeRunHandle;
}
```

兼容规则：

- mock、generic LLM 和 legacy CLI 继续使用 `run()`。
- Codex/Claude 流式模式使用 `start()`。
- `stream?/cancel?` 在 v0.2 双轨期保留，M5 再评审删除。
- RuntimeService 负责并发消费 events 和等待 result；Orchestrator 不直接管理 adapter 内部 handle map。

### 3.2 内部帧与共享事件

```text
CLI 原生帧
  -> RuntimeStreamFrame（server 内部）
  -> AgentRuntimeEvent（shared 合同）
  -> CollaborationEvent（时间线）
```

- `RuntimeStreamFrame` 不进入 shared 包。
- result frame 不进入时间线，但必须进入 `AgentRunResult.runtimeSession` 和 `usage`。
- tool output 写入时间线时只保留受限 preview，完整结果进入 artifact 或 result。

### 3.3 活性看门狗

每次 streaming run 独立维护：

- `firstFrameTimeoutMs`：默认 30 秒。
- `idleTimeoutMs`：默认 10 分钟，每个有效帧刷新。
- `absoluteTimeoutMs`：默认关闭，仅显式配置时启用。
- legacy run 没有真实事件流，由 Orchestrator 继续产生合成 heartbeat。

## 4. Codex 与 Claude 协议适配

### 4.1 Codex

Codex app-server 协议必须从当前 CLI 生成，不允许按 stub 猜方法名：

```powershell
codex app-server generate-ts --experimental --out <temp-dir>
codex app-server generate-json-schema --experimental --out <temp-dir>
```

Adapter 只实现生成协议中确认存在的：初始化、启动任务、Resume/Fork、通知、完成、取消和错误流程。

### 4.2 Claude

Claude adapter 使用 `--output-format stream-json --input-format stream-json`，并保证：

- stdout 按行解析。
- 单回合 `-p --input-format stream-json` 在写入首个 prompt 后关闭 stdin，以触发 CLI 输出 `result` 并退出；只有显式设置 `CLAUDE_CODE_STREAM_KEEP_STDIN_OPEN=true` 的双向 `control_request` 集成保留 stdin。
- session ID、usage、stderr tail 从原生结果映射。
- 原生 `result.is_error=true` 或非 `success` subtype 映射为 `MODEL_ERROR`，而不是 `OUTPUT_SCHEMA_INVALID`，以便 RuntimeService 执行一次 `RESUME_FALLBACK`。
- `--resume <id>` 失败时只回退一次。

## 5. Runtime Session Resumption

### 5.1 数据合同

```ts
export interface RuntimeSessionRef {
  cliSessionId?: string;
  workDir?: string;
}

export interface AgentRunResult {
  runtimeSession?: RuntimeSessionRef;
}
```

`RuntimeInvocationLog` 是 v0.2 的权威 Resume 数据源。

### 5.2 查询口径

首期只复用同一：

```text
(sessionId, agentId, taskId, runtimeType)
```

且必须是最近一条 `completed` invocation。跨 session 复用不在本批范围。

### 5.3 Fallback

Resume 失败或返回不同 session ID 时：

1. 结束当前进程。
2. 清除 resume 参数。
3. 启动一次新 session。
4. 产生 `RESUME_FALLBACK` 审计事件。
5. 第二次失败直接返回错误，不递归。

## 6. Actor v0.2

### 6.1 双写模型

```ts
type ActorType = 'user' | 'agent' | 'system';

interface ActorRef {
  type: ActorType;
  id: UUID;
  displayName?: string;
}
```

写入规则：

- Event 同时保留 `actor` 和旧 `fromAgentId`。
- Task 同时保留 `assignee/assignedBy` 和旧 agentId 字段。
- 前端和新服务优先读取 ActorRef，缺失时回退旧字段。
- v0.2 不删除旧字段，不合并消息事件类型。

### 6.2 回填

回填必须支持：

- file backend 的 `state.v0.1.json`。
- `eventsBySession`、`tasksBySession` collections。
- PostgreSQL `agent_cluster_collections` 或配置表名。
- 默认 dry-run、显式 apply、备份、幂等和不覆盖已有 ActorRef。

## 7. Workdir Brief

### 7.1 双目录

```text
executionWorkDir：真实源码目录，Runtime 在此执行
briefStagingDir：托管目录，保存生成文件、备份和恢复清单
```

### 7.2 注入协议

执行前：

1. 获取 execution workdir 独占 lease。
2. 读取 `AGENTS.md/CLAUDE.md` 原始字节和 hash。
3. staging 保存备份与 manifest。
4. 把原内容和生成块合并后原子替换。
5. 写入任务 sidecar。

执行后：

1. 恢复原始字节或删除原本不存在的文件。
2. 校验恢复 hash。
3. 释放 lease。

RecoveryService 启动时扫描未完成 manifest 并执行恢复。

## 8. Skill

- `Skill` 和 Agent 的 `skillIds` 进入 shared 合同。
- `SkillsService` 使用 `skills` JSONB collection。
- Agent 绑定仍由 AgentsService 持久化。
- Context Router/Context Pack Builder 把 Skill 内容按稳定顺序注入 `systemRules`。
- Workdir Brief 可把 Skill 渲染为稳定说明段落。
- Skill files 必须经过相对路径、大小和数量校验，不能任意写入用户目录。

## 9. Autopilot

Autopilot 复用 BullMQ，不引入第二套执行引擎：

```text
Autopilot Scheduler
  -> issueguard
  -> create Session(origin=autopilot)
  -> existing brief/execution pipeline
  -> AutopilotRun status
```

约束：

- 默认 `enabled=false`。
- issueguard 保证同一 Autopilot 同时只有一个 active run。
- 第一版只允许低风险或 mock runtime。
- Session、事件、artifact 必须保留 origin 和 autopilotRunId。
- 真实外部动作继续经过 Capability Module 与用户确认策略。

## 10. 灰度与兼容

```text
off   -> Codex legacy + Claude legacy
codex -> Codex streaming + Claude legacy
all   -> Codex streaming + Claude streaming
```

- 默认始终为 `off`，直至真实 CLI smoke 和全量回归通过。
- generic LLM 的结构化输出防御逻辑不因 CLI 改造而删除。
- M5 才评审删除 legacy adapter、deprecated actor 字段与旧 stream/cancel 合同。

## 11. 验证

每个阶段必须先通过定向测试，最终运行：

```powershell
npm run typecheck
npm run test
npm run test:harness
npm run build
```

并在 `off`、`codex`、`all` 三种模式分别执行对应 e2e。

## 12. 实现落点

| 设计域 | 主要实现 |
| --- | --- |
| Runtime RunHandle | `packages/shared/src/contracts.ts`、`RuntimeService.start()`、`runtime-stream-consumer.ts` |
| Codex app-server | `streaming/codex-appserver-codec.ts`、`codex-frame-parser.ts`、`codex-streaming-runner.ts` |
| Claude stream-json | `streaming/claude-stream-parser.ts`、`claude-streaming-runner.ts` |
| Resume/Fallback | `runtime.service.ts`、`build-resume-options.ts`、invocation log |
| Actor v0.2 | `events/derive-actor.ts`、`tasks.service.ts`、`scripts/backfill-actor-ref.mjs`、Web Actor helper |
| Workdir Brief | `streaming/workdir-brief.service.ts`、两个 CLI adapter、`RecoveryService` |
| Skill | `modules/skills/`、`Agent.skillIds`、Orchestrator `systemRules` 注入 |
| Autopilot | `modules/autopilot/`、`SessionDetail.origin/autopilotRunId`、BullMQ scheduler |

## 13. 运行边界

- `ENGINEERING_RUNTIME_STREAMING` 默认仍为 `off`；`codex` 和 `all` 只用于显式灰度。
- Workdir Brief 默认启用，可用 `AGENT_CLUSTER_WORKDIR_BRIEF=false` 关闭；它不绕过 `cap-file-write` 预检。
- Autopilot 只有在 `AUTOPILOT_ENABLED=true` 且 `ENABLE_BULLMQ=true` 时启用定时调度；手工触发仍要求 Autopilot 已启用或显式 `force`。
- Autopilot v0.1 强制 `runtimeType='mock'`、`riskLevel='low'`，不能执行真实高风险外部动作。
- legacy `execFile`、旧 Actor agentId 字段和旧 `stream/cancel` 合同继续保留一个兼容周期。
- PostgreSQL 回填、Redis scheduler、Workdir Brief 和真实 Claude CLI 已完成隔离环境验收；真实 Codex 仍受外部上游可用性阻塞。
