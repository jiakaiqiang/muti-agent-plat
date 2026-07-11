# Multica 对标·可落地改造方案 v1

> 更新时间：2026-07-09
> 定位：把 [`agent-cluster-vs-multica-architecture-v1.md`](./agent-cluster-vs-multica-architecture-v1.md) 的方向，落到**本仓库的具体文件、具体现状、具体改法**上。每一条都回答四个问题：现在长什么样、为什么这样有问题、改成什么、改完好在哪。
> 关联：
> - 运行时执行层深度对比 → [`multica-runtime-comparison-v1.md`](./multica-runtime-comparison-v1.md)
> - 全景架构对比与优先级 → [`agent-cluster-vs-multica-architecture-v1.md`](./agent-cluster-vs-multica-architecture-v1.md)
> - 相关根因记忆：本地 7B 模型 5 分钟超时窗口、重启孤儿化会话（见 memory `agent-freeze-root-cause-2026-07`）

---

## 1. 改造总览

| 编号 | 改造 | 主要文件 | 为什么改（一句话） | 优先级 |
|---|---|---|---|---|
| R1 | CLI adapter 改用原生流式协议 | `codex-runtime-adapter.service.ts`、`claude-code-runtime-adapter.service.ts` | 现在靠模型自觉吐 JSON，反复误判失败 | P0 |
| R2 | 硬超时改活性看门狗 | 同上 | 本地慢模型被 120s 固定窗口误杀 | P0 |
| R3 | Agent 提升为一等 Actor | `packages/shared/src/contracts.ts` | `agentId` 散落 16 处，语义不统一 | P0 |
| R4 | Session Resumption | `sessions.service.ts` + migration | 每次从零组装上下文，成本高 | P1 |
| R5 | 上下文注入改 workdir brief | 两个 CLI adapter | 整个 ContextPack 塞进单条 prompt | P1 |
| R6 | Skill 极简通道 | `modules/capabilities/` | 用户手动补知识只能走 RAG，太重 | P1 |
| R7 | Autopilot | 新增 `modules/autopilot/` | 所有任务只能手动发起 | P2 |

---

## R1. CLI adapter 改用原生流式协议 【P0，最高杠杆】

### 现状（有据可查）

`codex-runtime-adapter.service.ts`：

```
L2   import { execFile } from 'node:child_process';
L49  const { stdout, stderr } = await execFileAsync(command, commandArgs, { timeout, ... });
L149 return ['exec', '--json', prompt];               // 一次性执行，退出才有结果
L170 'Return one JSON object and no markdown fences.', // ← 靠模型自觉
L212 const parsed = JSON.parse(stdout.trim());         // ← 整体解析
L215-219 JSON.parse(parsed.result) / parsed.output / parsed.final_output // ← 层层猜
```

`claude-code-runtime-adapter.service.ts` 同构（L47 一次性 `execFile`、L140 同一句 prompt、L213 `JSON.parse`）。

最有力的证据是 **`generic-llm-runtime.service.ts` 有 1920 行**，其中一多半是在给"模型没按 schema 输出"擦屁股：

- `coerceRuntimeOutputWithoutKind`（L1195–1345，约 150 行）：模型没给 `kind` 时逐字段猜
- `toRuntimeOutput` / `detectRuntimeOutputKind`（L1113、L995）：深度递归找藏在 `output/result/data/content` 里的真实输出
- `jsonTextCandidates` + `escapeControlCharsInJsonStrings`（L1503、L1532）：模型在 JSON 字符串里写裸换行导致 `JSON.parse` 失败，手写状态机逐字符修复
- `schemaRepairMessages`（L462）：解析失败后再发一轮"请修成合法 JSON"
- `normalizeOutput`（L1036）：`status: "success"` 这类非法枚举值纠正成 `completed`

### 为什么这是问题（关联真实历史）

近三个 commit 全在修同一类根因：

```
d2baeaf feat: 增强运行时输出处理…
a9ba03b feat(orchestrator): needs_review 视为完成…不再误判失败
7271028 fix(runtimes): 归一化带 kind 的模型输出字段，修复成功结果被误判任务失败
```

这不是偶发 bug，是**架构选择的必然代价**：把"输出结构化"当成模型的义务，模型就一定会时不时违约，你就得永远追着补归一化。Multica 的做法相反——结构化信息来自 **CLI 原生协议帧**（`stream-json` 的 `assistant/tool_use/result` 事件），模型怎么胡说都不影响帧结构，平台零“猜 JSON”代码。

另外两个连带损失：
- **黑盒**：`execFile` 到进程退出才拿到 `stdout`，执行中前端只能干等，没有 timeline。
- **token 记账为 0**：`generic-llm` tool-loop 分支直接 `inputTokens: 0, outputTokens: 0`（L735–738），CLI adapter 同样没有真实用量。

### 改成什么（方向，非实现）

对齐 Multica `server/pkg/agent/claude.go` 的思路：

- **Claude**：`spawn`（不是 execFile）
  `claude -p --output-format stream-json --input-format stream-json --verbose ...`，
  stdout **逐行**解析 `stream-json` 事件 → 归一化成内部 `Message`。stdin 独立 goroutine/writer，避免与 stdout 读死锁。
- **Codex**：`spawn codex app-server --listen stdio://`，长驻 + JSON-RPC 2.0 双向。
- **关键原则**：`RuntimeOutput` 合同**从"模型输出义务"下移为"归一化层职责"**——即 `CLI 事件帧 → RuntimeOutput` 的映射由你的解析器保证，prompt 里不再写"Return one JSON object"。
- token 从 CLI 的 `result` 帧解析，按模型分桶。

```
// 伪代码思路
const child = spawn('claude', ['-p','--output-format','stream-json', ...]);
for await (const line of readline(child.stdout)) {
  const frame = JSON.parse(line);           // 每帧是合法 JSON，CLI 保证
  switch (frame.type) {
    case 'assistant':  emitEvent(...);        // 实时 timeline
    case 'tool_use':   emitEvent(...);
    case 'result':     finalOutput = mapToRuntimeOutput(frame); usage = frame.usage;
  }
}
```

实现要点：`stream-json` 帧类型枚举、readline 逐行读取、spawn 参数拼装、事件 DTO 类型是外层脚手架；核心在帧 → `RuntimeOutput` 的归一化映射、stdin/stdout 并发协调与错误帧处理。

### 收益

- **直接消除 `OUTPUT_SCHEMA_INVALID` 与"成功被误判失败"整类问题**，不用再追着补归一化。
- `generic-llm` 那套千行防御代码，对 CLI runtime **不再需要**（generic-llm 自身保留，因为它走 raw LLM API，仍要防御）。
- 执行过程可实时回传 → 前端 timeline。
- token 记账变真实。

### 验收标准

1. 新增 e2e：给 CLI 一个会输出长中文 + 代码块的任务，断言不再触发 `OUTPUT_SCHEMA_INVALID`。
2. 断言执行中至少产生 N 条中间事件（证明流式）。
3. 断言 `usage.totalTokens > 0`。
4. 先只改 Codex（app-server 常驻更清晰），跑通再迁 Claude；改前同步 `docs/contracts/runtime-contract-v0.1.md`。

---

## R2. 硬超时改活性看门狗 【P0，与 R1 同批】

### 现状

```
codex:  L42  Number(process.env.CODEX_RUNTIME_TIMEOUT_MS ?? 120_000)
claude: L42  Number(process.env.CLAUDE_CODE_TIMEOUT_MS  ?? 120_000)
```

`execFile` 的 `timeout` 是**wall-clock 死线**：到点直接杀进程，不管它是不是正在正常干活。

### 为什么是问题

memory `agent-freeze-root-cause-2026-07` 已记录：本地 7B 模型单轮就可能超过 5 分钟，120s 固定窗口会把**正常推理中**的任务误杀成 `RUNTIME_TIMEOUT`。慢 ≠ 死。

### 改成什么

Multica 的判据是"**只要还在产生事件就不杀**"（`runIdleWatchdog`）：

- 有了 R1 的流式帧，每收到一帧就刷新 `lastActivityAt`。
- 看门狗只在"**连续 idle 超过 X**"（如 Codex 的 semantic-inactivity 10 分钟）时才中断。
- 另设 `first-turn no-progress`（如 30s 内一帧都没有）快速失败，区分"卡死"与"慢"。

核心是 idle 判定与语义超时策略，定时器/看门狗骨架与配置项是外围。

### 收益

本地慢模型不再被误杀；快速失败仍能覆盖真卡死。**依赖 R1 的流式帧才能实现**，所以两者同批做。

---

## R3. Agent 提升为一等 Actor 【P0】

### 现状

`packages/shared/src/contracts.ts` 里"谁做的"散落成 16+ 个各异字段：

```
L131 targetAgentId?      L328 fromAgentId?      L352 agentId
L360 participatingAgentIds  L413 assignedByAgentId?  L414 assigneeAgentId?
L437/471/609/722 agentId?   L485 affectedAgentIds  L861 validatorAgentId?
L972 targetAgentIds?  L974 mentionedAgentIds?  L987/1000 alternativeAgentIds?
```

几乎全是 `agentId`，**没有与之对称的 `userId`/`memberId`**——说明当前建模默认"动作发起者只有 agent"，用户/系统作为 actor 的表达是缺位或临时拼的。

### 为什么是问题

- 语义不统一：同一个"谁"，在不同结构里叫 `fromAgentId`/`assigneeAgentId`/`actorId`，消费端到处 `if (agentId) ... else ...`。
- 扩展痛：将来要支持"agent 创建任务""系统自动发起""用户与 agent 同列于 timeline"，每加一种就要改几十处。

Multica 用一个 `xx_type + xx_id` 二元组贯穿 `issue/comment/inbox/activity_log`，agent 天生和 member 平权，"@agent 触发"不需要专门 API。

### 改成什么

```ts
// packages/shared/src/contracts.ts
export type ActorType = 'user' | 'agent' | 'system';
export interface ActorRef { type: ActorType; id: UUID; }
```

- 事件/任务/消息里的 `fromAgentId`/`assigneeAgentId`/... 逐步替换为 `actor: ActorRef` / `assignee: ActorRef`。
- `user_message` 与 `agent_message` 两类事件可合并为 `message` + `actor.type` 区分。
- 表加 `actor_type + actor_id` 列（无 FK，多态由应用层保证，照 Multica），一次性 migration 从旧列回填。

实现要点：migration DDL、回填脚本、旧字段 → ActorRef 的机械替换清单是机械部分；核心在 `ActorRef` 类型设计、事件模型合并决策、各消费端语义收敛。

### 收益

- 一处定义，处处一致；新增 actor 种类零散改。
- 为 R7 Autopilot 的 `system` 发起者、以及"agent 主动建任务/发评论"直接铺好路。
- **一次性大改动**（涉及多数事件消费者），建议独立分支、先在 `docs/design/agent-cluster-system-design-v1.md` 落设计再动。

---

## R4. Session Resumption 【P1，R1 落地后近乎白捡】

### 现状

`sessions.service.ts` 每次新会话从零组装 ContextPack（Memory + RAG 检索 + projectMap），CLI 侧无任何续接。

### 为什么是问题

- 组装成本高、失真率大；同一 issue 的第二轮完全丢掉第一轮的文件系统状态、git 状态、CLI 原生上下文。

### 改成什么

Multica `020_task_session.sql` 只加两列就实现：

```sql
ALTER TABLE agent_task ADD COLUMN session_id TEXT;
ALTER TABLE agent_task ADD COLUMN work_dir  TEXT;
```

流程：
1. CLI 执行完把返回的 `session_id` + `work_dir` 写回本条 task。
2. 下次派发同 `(agent_id, issue_id)`，查上一条 completed task 的这两列，塞进给 adapter 的输入（对应 Multica `PriorSessionID/PriorWorkDir`）。
3. adapter 用 `claude --resume <session_id>` 复用；**resume 失败要回退到新会话**（Multica 有此兜底）。

核心在派发时的续接决策与 resume 失败回退逻辑；migration 与查询上一条 task 的 SQL/DTO 是外围。

### 收益

上下文/文件/git 状态跨轮保留，Memory+RAG 组装压力骤降。**前提是 R1 已让 adapter 能拿到 CLI 的 `session_id`**。

---

## R5. 上下文注入改 workdir brief 【P1】

### 现状

两个 adapter 都把整个 ContextPack `JSON.stringify` 拼进**单条 prompt**（codex L189、claude L159 附近，`sessionGoal`/`contextPack` 一起塞）。

### 为什么是问题

- 单条巨型 prompt 挤占 token、稀释注意力；CLI 原生的上下文加载机制（读 `CLAUDE.md`/`AGENTS.md`）完全没用上。

### 改成什么

Multica `InjectRuntimeConfig`：把 ContextPack 里**稳定部分**（agent instructions、约束、技能清单）写进 workdir 的 `CLAUDE.md`/`AGENTS.md`，任务上下文写 `.agent_context/` sidecar，prompt 只留任务本身；任务结束**清理还原**（尤其 workdir 是用户真实目录时逐字节还原）。

关键决策：哪些进 brief 文件、哪些留 prompt 的切分策略；清理还原逻辑涉及用户文件安全，务必先备份/还原验证。

### 收益

token 下降、CLI 上下文利用率上升。**注意安全边界**：写/还原用户目录属高风险操作，实现时必须有还原验证与失败兜底。

---

## R6. Skill 极简通道 【P1，补充而非替换 Memory/RAG】

### 现状

用户想手动补一份"部署说明/团队规范"给某 agent，只能走 RAG 上传或塞 memory，重且慢。

### 改成什么

在 `modules/capabilities/` 下加 Multica 式极简三表：

```sql
skill(workspace_id, name, description, content, files JSONB)
agent_skill(agent_id, skill_id)
```

- 组装 ContextPack 时把该 agent 挂载的 skill 注入 `constraints`/`systemRules`。
- 进阶（R1/R5 后）：改为写 `work_dir/.claude/skills/<name>/SKILL.md`，让 CLI 自读，更省 token。

### 收益

给用户一条"我直接告诉你怎么做"的自助通道，不必等 Memory 自动沉淀。

---

## R7. Autopilot 【P2，最后做】

### 现状

所有 session 都要用户手动发起。

### 改成什么

BullMQ 已在，直接：`autopilot(workspace_id,name,trigger_type,trigger_config,issue_template,agent_id,enabled)` + `autopilot_run`；repeatable job 定时触发；加 issueguard 防同一 autopilot 未完成时重复建单；session/issue 加 `origin` 追溯。核心在触发→建单→派发的编排与 issueguard 去重算法。

### 收益

周期任务（每日巡检、triage）自动化，仍复用现有任务队列，不引入第二套执行引擎。

---

## 2. 执行顺序与依赖

```
第一批（P0，一个分支一件事）
  R1 CLI 原生协议 ──┬─ 必须先做，是 R2/R4 的前提
  R2 活性看门狗 ────┘ 依赖 R1 的流式帧
  R3 Actor 一等公民   独立进行，领域建模，先落设计文档

第二批（P1）
  R4 Session Resumption  ← 依赖 R1
  R5 workdir brief 注入   ← 依赖 R1，涉及用户文件安全
  R6 Skill 极简通道       独立

第三批（P2）
  R7 Autopilot            ← 依赖 R3 的 system actor
```

## 3. 通用注意

- Multica 是 Go，**代码不能搬，搬的是架构模式**。
- R1/R2/R5 改前先更新 `docs/contracts/runtime-contract-v0.1.md` 与相关 e2e（`tests/e2e/`）。
- R3/R4 改前先在 `docs/design/agent-cluster-system-design-v1.md` 落设计再写 migration。
- R5 涉及写/还原用户目录，属高风险，须有还原验证与失败兜底，改动前明确影响范围。

## 附：证据索引

- 一次性 exec + 猜 JSON：`codex-runtime-adapter.service.ts:49,149,170,212`、`claude-code-runtime-adapter.service.ts:47,140,213`
- 归一化防御代码规模：`generic-llm-runtime.service.ts` 全 1920 行，重点 L462/L995/L1036/L1113/L1195/L1503/L1532
- 硬超时：两 adapter `L42`
- Actor 散落：`packages/shared/src/contracts.ts` L131/328/352/360/413/414/437/471/485/609/722/861/972/974/987/1000
- 反复修误判：git `d2baeaf`、`a9ba03b`、`7271028`
- 超时误杀根因：memory `agent-freeze-root-cause-2026-07`
