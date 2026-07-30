# Multica 对标改造补全执行计划 v1

> 日期：2026-07-10  
> 状态：R1～R7 已实现；Codex 本地 CLI/Runtime 标记为可用，但生产模型上游在 2026-07-12 三次补验中均返回 502；P0 的 Claude/PostgreSQL/Redis/Workdir 已通过；P1 的 Skill 前端已完成，Watchdog 工程实现完成但 20 次真实采样受 20 元费用上限阻断
> 上游分析：[`../analysis/multica-actionable-refactor-plan-v1.md`](../analysis/multica-actionable-refactor-plan-v1.md)  
> 相关设计：[`../design/multica-refactor-development-design-v1.md`](../design/multica-refactor-development-design-v1.md)  
> 交接记录：[`../task-trans/HANDOFF-2026-07-10.md`](../task-trans/HANDOFF-2026-07-10.md)

## 1. 目标

本计划负责把 Multica 对标方案中的 R1～R7，从当前的代码骨架或设计状态推进到可验证交付状态。

完成标准不是“文件已经存在”或“纯函数单测通过”，而是：

- 关键链路能够端到端运行。
- `npm run typecheck`、`npm run test`、`npm run test:harness`、`npm run build` 全绿。
- Streaming、Session Resume、Workdir Brief 和 Skill 有对应 e2e。
- 合同、功能清单和 Changelog 与代码同步。
- legacy 路径在灰度期保持兼容。

## 2. 已确认约束

- 最终质量门要求全量 TypeScript 类型检查通过，不继续豁免当前 Streaming 相关错误。
- 实施前先保护当前脏工作树：新建修复分支，并在明确授权后创建基线 checkpoint commit。
- `ENGINEERING_RUNTIME_STREAMING` 默认保持 `off`，通过 `codex`、`all` 分阶段灰度。
- 真实 Codex/Claude CLI 可用是目标；stub 只作为稳定、可重复的自动化测试工具。
- legacy `execFile` 路径在本批保留，删除工作放到后续 v0.3/M5 专题评审。
- 使用现有 `PersistenceService` JSONB collection，不引入 Prisma 或第二套数据库。
- 不直接把 Harness Engineering 产品化为运行时模块。
- R5 写入用户工作区属于高风险行为，必须具备原子备份、逐字节恢复、崩溃恢复和并发互斥。
- R7 默认禁用，第一版不得绕过现有能力治理和用户确认边界。

## 3. 当前完成度审计

### 3.1 总览

| 项目 | 当前状态 | 已有实现 | 未闭环部分 |
| --- | --- | --- | --- |
| R1 CLI 原生流式协议 | 完成（Codex 本地可用、Claude 真实验收通过） | Codex CLI 已安装登录并可启动 app-server；统一 RunHandle；Codex app-server JSONL 生命周期；Claude stream-json；结构化结果、usage、cancel、stub e2e；Claude 真实 Resume/fallback/cancel 通过 | Codex 生产真实调用仍受外部模型上游阻塞 |
| R2 活性看门狗 | 功能完成，生产基线待验收 | first-frame、idle、absolute watchdog；streaming 真实事件刷新；legacy 合成 heartbeat；首帧/帧间隔/总时长指标；完整 timeout 诊断；20 次采样与分位数分析工具 | 每个目标 Runtime 仍需至少 20 次真实 completed 样本、最终参数批准和回滚演练 |
| R3 Actor 一等公民 | 完成（v0.2 双写） | Event/Task 新旧字段双写；前端 ActorRef 优先；file/PostgreSQL collection 回填、备份与 dry-run；隔离 PostgreSQL apply/回滚验收 | v0.3 才删除旧 agentId 字段 |
| R4 Session Resumption | 完成 | `runtimeSession` 显式回传；同 runtime/workdir 校验；Codex/Claude resume；单次 fallback 与审计事件 | 不支持跨 session 恢复；真实 CLI session 需外部环境验收 |
| R5 Workdir Brief | 完成 | staging、sidecar、原子注入、逐字节恢复、lease、启动恢复、TTL、精简 prompt | 默认开启但仍受 source-write capability preflight 约束 |
| R6 Skill | 完成（含管理前端） | shared 合同、JSONB collection CRUD、Agent 绑定、稳定顺序注入 ContextPack/Workdir Brief、清理悬空引用；Web 列表/编辑/文件/绑定/删除影响/注入预览 | 无当前阶段遗留；更高级版本治理留待独立需求 |
| R7 Autopilot | 完成（功能门控） | CRUD、手工触发、BullMQ scheduler、issueguard、run/session 追踪、mock/low-risk 限制；真实 Redis 重启恢复验收 | 默认禁用；真实 Runtime 和高风险治理归入 P2 |

### 3.3 本轮实施记录

- 阶段 0 未创建分支或 checkpoint commit：当前会话没有获得 commit/push/PR 授权，且保留了用户已有脏工作树。
- 阶段 1～8 的代码、单元测试、受控 stub e2e 和合同同步已经完成。
- Codex 协议依据本机 `codex-cli 0.144.1` 生成的 app-server TypeScript/JSON Schema 实现；自动化测试使用遵循该协议的 JSONL stub。
- PostgreSQL Actor 回填已通过 fake-pool 单测，并在隔离 PostgreSQL 实例完成真实 `--apply` 等价路径、备份和回滚演练。
- Autopilot 已连接隔离 Redis 执行 BullMQ scheduler、issueguard、队列指标、停用和进程重启恢复验收。
- Workdir Brief 已在 Windows 隔离目录完成生产安全演练；真实 CLI 调用仍受显式成本门控。
- P1 PR-06 已补齐 Skill 管理前端、组件测试和浏览器 e2e。
- P1 PR-05 已补齐 stream metrics、timeout 诊断、独立阈值配置、真实采样模式和基线分析器；真实 20 次采样未获本轮成本授权，尚未执行。

### 3.4 P0/P1 统一闭环状态

| 编号 | 状态 | 当前证据 | 剩余动作 |
| --- | --- | --- | --- |
| PR-01 | 部分通过/外部阻塞 | Claude 真实 primary/resume/fallback/cancel/legacy 通过；Codex 历史三次 `upstream_400`，2026-07-12 三次新 probe 均返回 502 且零 token | 上游恢复或切换有效配置后补跑 Codex |
| PR-02 | 完成 | 隔离 PostgreSQL dry-run/apply/幂等/备份/回滚通过 | 无 |
| PR-03 | 完成 | 隔离 Redis/BullMQ 调度/去重/停用/重启恢复/指标通过 | 无 |
| PR-04 | 完成 | Windows 字节恢复/崩溃恢复/lease/失败留证/TTL 通过 | 无 |
| PR-05 | 实现完成、验收待采样 | 基线分析器测试 2/2；Claude 单次 probe 成功，49,762 tokens；真实采样入口具备成本门控 | 提高当前 20 元费用上限或提供可审计的订阅额度后，每个目标 Runtime至少 20 次真实采样、批准参数和回滚演练 |
| PR-06 | 完成 | Web 组件测试 2/2、Skill 管理浏览器 e2e、Web build 和本轮全量回归通过 | 无 |

因此当前不能把 P0/P1 标记为统一闭环，P2 继续冻结。

### 3.5 已纳入计划、暂不启动的任务

> 当前决策（2026-07-10）：以下任务只登记到计划，不进入执行。当前不运行真实 CLI 探针、不执行 20 次采样、不调整生产候选参数，也不产生相关模型调用费用。只有用户后续明确发出“开始执行”指令，并同时给出任务所需授权后，才允许解除暂停状态。

#### TASK-P1-05-WATCHDOG-STAGING-BASELINE

| 属性 | 内容 |
| --- | --- |
| 来源 | P1 PR-05 Watchdog 参数与可观测性基线 |
| 状态 | 已纳入计划，暂不启动；工程实现和本地验证已完成 |
| 启动门禁 | 用户明确指定开始执行，并确认目标 Runtime、次数、费用上限和 staging 环境 |
| 目标 | 为每个准备进入生产配置表的 Runtime 采集至少 20 次真实 completed 样本，形成最终 first-frame/idle 参数和回滚证据 |
| 前置条件 | 明确目标 Runtime、每个 Runtime 的运行次数、费用上限、隔离 staging workdir、有效 CLI 登录和可用模型上游 |
| 执行入口 | `REAL_CLI_PHASE=sample`、`REAL_CLI_RUNS_PER_RUNTIME>=20`、`npm run test:e2e:real-cli-acceptance` |
| 分析入口 | `npm run report:watchdog-baseline` |
| 交付物 | 原始脱敏样本报告、P50/P95/P99/max、批准后的环境变量、慢任务/卡死故障证据和配置回滚记录 |
| 完成标准 | 每个目标 Runtime 样本数达标；正常慢任务不被误杀；三类 timeout 可区分；最终参数获批准并完成回滚演练 |

解除暂停后的执行顺序：

1. 用户或发布负责人明确 Runtime、次数和费用上限。
2. 在隔离 staging 执行 20 次以上只读样本。
3. 生成候选参数报告并进行人工评审。
4. 使用候选参数验证持续事件超过 120 秒、无首帧、idle 卡死和显式 absolute 场景。
5. 演练恢复上一组配置，并更新 PR-05 验收报告。

Claude Code 子任务可在获得成本授权后执行；Codex 子任务必须先解除 `TASK-P0-01-CODEX-REAL-ACCEPTANCE` 的上游阻塞。

#### TASK-P0-01-CODEX-REAL-ACCEPTANCE

| 属性 | 内容 |
| --- | --- |
| 来源 | P0 PR-01 真实 Codex/Claude CLI 验收中的 Codex 剩余部分 |
| 状态 | 已纳入计划，暂不启动；同时存在外部阻塞，三次真实首轮调用均返回 `upstream_400` |
| 启动门禁 | 用户明确指定开始执行；供应商通道恢复或已提供确认可用的新配置；单次探针和完整验收费用上限已确认 |
| 目标 | 证明 Codex app-server 在有效模型上游中完成 primary、Resume、失效 Resume fallback、cancel、legacy 显式失败和 Workdir Brief 恢复 |
| 前置条件 | 供应商通道恢复或切换为确认可用的 Codex 模型/区域配置；明确单次探针和完整验收的费用上限 |
| 最小探针 | `REAL_CLI_RUNTIME=codex`、`REAL_CLI_PHASE=probe`、`npm run test:e2e:real-cli-acceptance` |
| 完整验收 | 最小探针成功后执行 `REAL_CLI_PHASE=all`，不得在 `upstream_400` 持续时无界重试 |
| 交付物 | CLI/模型配置记录、脱敏真实验收报告、usage/sessionId、Resume/fallback/cancel 证据和用户说明文件字节恢复结果 |
| 完成标准 | 最小探针成功；完整场景全部通过；没有 mock fallback；报告、已知限制和回滚方式同步到 P0 验收文档 |

解除暂停后的执行顺序：

1. 确认供应商状态或新的可用配置，并记录 CLI/模型版本。
2. 获得成本授权后只执行一次最小探针。
3. 探针成功后执行完整验收；失败时停止并保留脱敏错误证据。
4. 更新 PR-01 状态；如 Codex 也是生产目标 Runtime，再继续执行其 Watchdog 20 次采样。

任务依赖关系：

```text
TASK-P0-01-CODEX-REAL-ACCEPTANCE
  └─ 成功后，允许执行 Codex 的 TASK-P1-05-WATCHDOG-STAGING-BASELINE

Claude Code 的 TASK-P1-05-WATCHDOG-STAGING-BASELINE
  └─ 不依赖 Codex 上游，只依赖明确的成本授权和 staging 环境
```

暂停期间允许继续维护文档和非成本型本地测试，但不得把这些维护视为任务已启动，也不得因此解锁 P2。

### 3.2 已确认的阻断缺陷

1. `buildResumeOptions` 定义接受 `(phase, prior)`，orchestrator 当前传入单个对象，Resume 不会进入 `AgentRunInput.options`。
2. `frameToRuntimeEvent` 定义接受 `(runId, frame)`，Codex/Claude adapter 当前参数顺序和数量错误。
3. orchestrator 在 runtime 建立 streaming handle 前消费 `stream()`，可能得到空迭代器。
4. Claude runner 调用不存在的 `parser.parseLine()`，实际 parser 方法为 `feedLine()`。
5. result frame 中的 `cliSessionId` 没有稳定进入 `AgentRunResult`，`RuntimeInvocationLog` 无法可靠记录 Resume ID。
6. Codex runner 当前只发送 `initialize`，stub 把任意请求当作执行请求，不能证明真实 app-server 兼容。
7. Actor 回填脚本默认读取 `persistence.json` 和 `agentTasks`，实际默认文件与 collection 分别是 `state.v0.1.json`、`tasksBySession`。
8. Web Actor 测试使用 Vitest，但当前 Web workspace 没有对应依赖和测试入口。

## 4. 架构决策

### 4.1 Streaming 使用同步 RunHandle

当前 `run()`、`stream(runId)` 和 adapter 内 handle map 分离，导致消费者可能早于 handle 注册。

新增兼容接口：

```ts
export interface AgentRuntimeRunHandle {
  result: Promise<AgentRunResult>;
  events: AsyncIterable<AgentRuntimeEvent>;
  cancel(): Promise<void>;
}

export interface AgentRuntimeAdapter {
  run(input: AgentRunInput, signal?: AbortSignal): Promise<AgentRunResult>;
  start?(input: AgentRunInput, signal?: AbortSignal): AgentRuntimeRunHandle;
}
```

- Streaming adapter 使用 `start()`，同步返回 result、events、cancel。
- legacy/mock/generic adapter 继续使用 `run()`。
- RuntimeService 在拿到 handle 后立即消费 events，再等待 result。
- 原有 `stream?/cancel?` 在一个兼容周期内保留，后续 M5 再删除。

### 4.2 Runtime Session 使用显式结果字段

不再从普通事件 metadata 猜测 CLI session 信息：

```ts
export interface RuntimeSessionRef {
  cliSessionId?: string;
  workDir?: string;
}

export interface AgentRunResult {
  // 现有字段省略
  runtimeSession?: RuntimeSessionRef;
}
```

`RuntimeService` 从 `result.runtimeSession` 写入 invocation log。`RuntimeInvocationLog` 是首期 Resume 的权威来源，不在 `AgentTask` 重复维护同一份状态。

### 4.3 Actor 首期采用 v0.2 双写

- 新字段：`actor`、`assignee`、`assignedBy`。
- 旧字段：`fromAgentId`、`assigneeAgentId`、`assignedByAgentId` 保留并标记 deprecated。
- 所有新写入必须同时维护新旧字段。
- 本批不合并 `user_message/agent_message`，不删除旧字段。

### 4.4 Workdir 区分执行目录与 staging 目录

```text
executionWorkDir = 真实源码目录，CLI 在这里执行
briefStagingDir  = ~/.agent-cluster/workspaces/<session>/<task>/
```

- staging 保存生成内容、原始文件备份和恢复清单。
- `AGENTS.md/CLAUDE.md` 只在运行期间原子注入真实源码目录。
- 任务结束立即还原真实源码目录；staging 保留到 session 删除或 TTL 到期。
- Resume 记录的是 `executionWorkDir`，不是 staging 目录。
- 同一个 execution workdir 使用独占 lease，防止并行任务交叉覆盖 brief。

## 5. 分阶段执行计划

### 阶段 0：保护工作树与记录基线

#### 任务

1. 创建修复分支，例如 `repair/multica-runtime-completion`。
2. 在用户确认提交后，为当前工作树创建 checkpoint。
3. 记录：
   - `git status --short`
   - `npm run typecheck`
   - Streaming 定向测试
   - Actor/Resume 定向测试

#### 完成门槛

- 可以无损返回当前接手状态。
- 不使用 `git reset --hard`、`git checkout --` 或未审查的 stash 覆盖已有修改。

### 阶段 1：恢复编译与单元测试基线

#### 主要文件

- `apps/server/src/modules/runtimes/streaming/`
- `apps/server/src/modules/runtimes/codex-runtime-adapter.service.ts`
- `apps/server/src/modules/runtimes/claude-code-runtime-adapter.service.ts`
- `apps/server/src/modules/orchestrator/`
- 对应 spec

#### 任务

1. 修正 `buildResumeOptions` 调用。
2. 修正 `frameToRuntimeEvent` 参数。
3. 收紧 `runtime-stream-consumer` 的 dependency 类型。
4. 将 Claude `parseLine` 修正为 `feedLine`，同步 stub 输入结构。
5. 补齐 `RuntimeFileChange.operation` 映射。
6. 修正 JSON-RPC spec 的 `'2.0'` literal。
7. 修正 Node 20 mock timer API 使用方式。
8. 修正 `analysis_report` 测试类型。

#### 完成门槛

```powershell
npm run typecheck
```

Streaming、Actor、Resume 定向单测全部通过。

#### 建议提交

```text
fix(runtime): restore streaming and resume compile baseline
```

### 阶段 2：完成 R1/R2 Codex 流式闭环

#### 协议验证门

本机 `codex-cli 0.144.1` 已确认提供 app-server 和协议生成命令。实施时先生成当前版本的真实协议定义：

```powershell
codex app-server generate-ts --experimental --out $env:TEMP\codex-appserver-ts
codex app-server generate-json-schema --experimental --out $env:TEMP\codex-appserver-schema
```

禁止依据当前 stub 猜测真实 JSON-RPC method。

#### 任务

1. 增加 `AgentRuntimeRunHandle/start()` 兼容合同。
2. RuntimeService 根据 `start()` 选择流式执行，根据 `run()` 选择 legacy 执行。
3. 按生成协议完成 app-server 初始化、任务启动、通知解析、完成和取消。
4. result frame 映射 `RuntimeOutput`、`runtimeSession` 和 usage。
5. Watchdog 绑定本次 handle：
   - first-frame 默认 30 秒。
   - idle 默认 10 分钟。
   - absolute 默认关闭或显式配置。
6. legacy 路径保留合成 heartbeat。

#### 测试

- 官方协议 fixture/codec/parser 单测。
- handle 启动、事件顺序、取消、first-frame、idle 测试。
- 长中文与代码块不触发 `OUTPUT_SCHEMA_INVALID`。
- timeline 产生真实中间事件。
- `usage.totalTokens > 0`。
- stub e2e 必跑；真实 CLI smoke 作为受控本地验收。

#### 建议提交

```text
feat(runtime): complete codex app-server streaming lifecycle
```

### 阶段 3：完成 R1/R2 Claude 流式闭环

#### 任务

1. 根据本地 Claude CLI 版本确认 stream-json 输入输出。
2. 修复初始 prompt 和 control request writer。
3. 接入统一 RunHandle。
4. 对齐 session ID、usage、stderr tail、取消和 watchdog 语义。
5. `ENGINEERING_RUNTIME_STREAMING=codex` 时保持 Claude legacy。
6. `ENGINEERING_RUNTIME_STREAMING=all` 时启用 Claude streaming。

#### 完成门槛

```powershell
$env:ENGINEERING_RUNTIME_STREAMING='all'
node tests/e2e/claude-streaming-smoke.mjs
```

#### 建议提交

```text
feat(runtime): complete claude stream-json lifecycle
```

### 阶段 4：完成 R3 Actor v0.2

#### 任务

1. `TasksService.createFromSuggestions()` 同时写新旧 assignee/assignedBy 字段。
2. 任务改派、插话任务和手工 add/update 路径保持双写。
3. 前端 sender/assignee 解析统一走 Actor helper。
4. 修复 file backend 回填：
   - `state.v0.1.json`
   - `eventsBySession`
   - `tasksBySession`
5. 增加 PostgreSQL collection 回填模式。
6. 默认 dry-run；`--apply` 前创建备份并输出统计。
7. 补齐 Web 测试入口。

#### 本阶段非目标

- 删除旧 agentId 字段。
- 合并消息事件类型。
- v0.3 contract cleanup。

#### 建议提交

```text
feat(actor): complete v0.2 actor dual-write migration
```

### 阶段 5：完成 R4 Session Resumption

#### 依赖

R1/R2 的 result 必须能提供真实 `runtimeSession`。

#### 任务

1. RuntimeService 从 `result.runtimeSession` 写 invocation log。
2. 修复 prior invocation lookup 与 options 注入。
3. Codex 使用生成协议中的 resume/fork 请求。
4. Claude 使用 `--resume <id>`。
5. Resume 前验证 workdir 存在、路径在允许范围内且 runtime 类型一致。
6. Resume 失败最多回退一次：
   - 移除 resume。
   - 启动新 session。
   - 产生 `runtime_progress` / `RESUME_FALLBACK`。
7. 第二次失败直接返回，不允许无限递归。

#### 新增测试

- `runtime.service.spec.ts`
- orchestrator Resume 集成测试
- Codex/Claude fallback 测试
- `tests/e2e/session-resumption-smoke.mjs`

#### 建议提交

```text
feat(runtime): persist and dispatch runtime session resume
feat(runtime): add one-shot resume fallback and audit event
```

### 阶段 6：完成 R5 Workdir Brief

#### 主要文件

- `apps/server/src/modules/runtimes/streaming/workdir-brief.service.ts`
- 两个 CLI adapter
- RecoveryService
- 对应 spec/e2e

#### 任务

1. staging 保存生成的 `AGENTS.md`、`CLAUDE.md`、`task-brief.json`、`backup-manifest.json`。
2. 执行前读取真实文件原始字节并创建恢复 manifest。
3. 把原内容和生成块合并后原子写入。
4. 执行结束逐字节还原并验证 hash。
5. 进程崩溃后由 RecoveryService 扫描 manifest 恢复。
6. 同一 execution workdir 加独占 lease。
7. staging 按 session 删除或 TTL 清理。
8. prompt 只保留 Agent 角色、当前任务、expected output kind 和 task sidecar 路径。
9. mock/generic LLM 路径保持不变。

#### 完成门槛

- 原文件不存在、已存在、运行失败和进程崩溃四种场景都能恢复。
- 连续写两次不叠加内容。
- prompt 长度明显下降。
- `tests/e2e/workdir-brief-smoke.mjs` 通过。

#### 建议提交

```text
feat(runtime): add recoverable workdir brief injection
feat(runtime): slim cli prompts with workdir context
```

### 阶段 7：完成 R6 Skill

#### 任务

1. Shared 合同增加 `Skill` 和 `Agent.skillIds`。
2. `SkillsService` 使用 `skills` JSONB collection。
3. 增加 Skill CRUD 与 Agent 绑定 API。
4. 校验 name、content、files 的长度和路径。
5. ContextPack 按稳定顺序注入 skill 内容到 `systemRules`。
6. R5 可用后同时写入 workdir brief。
7. 删除 Skill 时清理 Agent 悬空引用。

#### 测试

- Service CRUD 四类测试。
- Controller 和绑定测试。
- 无 Skill 时 ContextPack 不变。
- 多 Skill 注入顺序稳定。
- `tests/e2e/skill-injection-smoke.mjs`。

#### 建议提交

```text
feat(skills): add skill storage api and runtime injection
```

### 阶段 8：R7 Autopilot 独立里程碑

R7 不与 M4/R1～R6 混在同一 PR。

#### 任务

1. 新增 `Autopilot`、`AutopilotRun` 合同。
2. 增加 `autopilots`、`autopilotRuns` JSONB collections。
3. Session 增加 `origin: user | autopilot`。
4. 复用 BullMQ repeatable/job scheduler。
5. 使用 `autopilot:<autopilotId>:active` issueguard 防重复。
6. 默认 `enabled=false`。
7. 第一版只允许低风险或 mock runtime。
8. 增加手工 trigger endpoint，支持确定性 e2e。

#### 完成门槛

- 重复触发只产生一个 active run。
- worker 重启不重复创建 session。
- disable 后停止调度。
- session、事件和产物可追溯到 Autopilot。

## 6. 分支与提交组织

建议拆分为独立 PR，降低回归和审查压力：

1. PR-0：当前基线修复。
2. PR-1：R1/R2 Codex。
3. PR-2：R1/R2 Claude。
4. PR-3：R3 Actor v0.2。
5. PR-4：R4 Resume。
6. PR-5：R5 Workdir Brief。
7. PR-6：R6 Skill。
8. PR-7：R7 Autopilot。
9. PR-8：全量回归与文档状态更新。

任何 commit、push 或 PR 创建操作均需要执行时再次确认。

## 7. 验证矩阵

### 7.1 基础质量门

```powershell
npm run typecheck
npm run test
npm run test:harness
npm run build
```

### 7.2 legacy 回归

```powershell
$env:ENGINEERING_RUNTIME_STREAMING='off'
npm run test:e2e:main-chain
npm run test:e2e:runtime-routing
```

### 7.3 Codex 灰度

```powershell
$env:ENGINEERING_RUNTIME_STREAMING='codex'
node tests/e2e/codex-streaming-smoke.mjs
node tests/e2e/session-resumption-smoke.mjs
```

### 7.4 全 Streaming

```powershell
$env:ENGINEERING_RUNTIME_STREAMING='all'
node tests/e2e/claude-streaming-smoke.mjs
node tests/e2e/workdir-brief-smoke.mjs
```

### 7.5 Skill

```powershell
npm run test --workspace @project/web
npm run test:e2e:skill-injection
npm run test:e2e:skill-management
```

### 7.6 Autopilot

```powershell
npm run test:e2e:autopilot
```

### 7.7 2026-07-10 R1～R7 基线验收结果

- `npm run typecheck`：通过。
- `npm run test`：325/325 通过。
- `npm run test:harness`：Phase 1～5 全部通过。
- `npm run build`：通过（shared/server/web）。
- Streaming、Resume、Workdir Brief、Skill、Autopilot 冒烟：通过。
- `ENGINEERING_RUNTIME_STREAMING=off` 下 main-chain、runtime-routing、Codex legacy、Claude legacy：通过。

### 7.8 2026-07-10 P1 增量验收结果

- PR-06：Web build、2 项组件测试和 Skill 管理浏览器 e2e 通过。
- PR-05：服务端 338 项测试和 Watchdog 基线分析器 2 项测试通过。
- 完整质量门：typecheck、server 338/338 + Web 2/2、Harness Phase 1～5、shared/server/web build 全部通过。
- 定向回归：workspace-chrome、chinese-copy、real-data-mode、skill-injection、skill-management、codex-streaming、claude-streaming 全部通过。
- 20 次真实 CLI 采样未执行；该操作会产生模型费用，必须在明确批准 Runtime、次数和费用上限后执行。
- P1 完整质量门与剩余项见 `docs/quality/multica-p1-acceptance-report-v1.md`。

## 8. 完成定义

R1～R6 只有同时满足以下条件才可在功能清单中标记为完成：

- 本阶段定向测试通过。
- 基础质量门全绿。
- legacy/off 模式无行为回归。
- 新路径有对应 e2e。
- 合同和功能状态文档同步。
- 没有以“历史遗留错误”为理由豁免本阶段相关失败。

R7 必须单独发布和验收，不作为 M4 完成的前置条件。

## 9. 文档同步清单

最终交付阶段更新：

- `docs/contracts/runtime-contract-v0.1.md`
- `docs/contracts/event-contract-v0.1.md`
- `docs/contracts/data-contract-v0.1.md`
- `docs/contracts/api-contract-v0.1.md`
- `docs/design/agent-cluster-system-design-v1.md`
- `docs/analysis/feature-inventory-and-status-v1.md`
- 根 `CHANGELOG.md`

文档只能在对应实现和验收通过后将状态更新为“完成”。
