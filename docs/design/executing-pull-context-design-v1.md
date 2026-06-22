# 执行阶段 Pull 式上下文获取设计 v1

> 文档定位：解决"群聊向大目录预灌内容、Agent 看不见真实项目"的根因
> 范围：仅"任务执行阶段"切到按需读取；讨论阶段保持现有 Push 流程不变
> 兼容：与现有 ContextPack / ContextRouter / EngineeringRuntime 合同正交，不重写
> 状态：DRAFT
> 生成时间：2026-06-18

## 1. 背景与问题

### 1.1 现状（已验证代码事实）

当前群聊处理目录信息的链路：

1. 前端创建会话时递归扫描整个目录，把文件**内容**直接读入 `workspaceSnapshot.files[].content`（`apps/web/src/stores/localWorkspace.ts:208-292`）。前端硬限额 350 条目 / 80 个文本文件 / 单文件 80KB / 总量 550KB。
2. snapshot 随 `POST /sessions` 一起上传；后端把它存进 session（`apps/server/src/modules/sessions/sessions.service.ts:117`）。
3. 每次 Agent 执行前的 `createContextPack` 都把 snapshot 包进 ContextPack。
4. 撞预算靠 `fitContextToBudget` 6 级事后裁剪（`apps/server/src/common/token.ts:69-261`）。emergency 级直接清空 `tree/files/skipped`，只留 rootName + fileCount。
5. Agent 自身**不主动读文件**，看到啥就只是预灌的那一份。

### 1.2 这套机制的代价

- **大目录信息密度被砍废**。emergency 级 `workspaceSnapshot` 是 `tree:[], files:[]`（`token.ts:233-235`）。Agent 看到的等于"这是个什么名字的目录"。
- **均匀采样不区分重要性**。前端扫到 80 个文件就停，不知道哪个是入口。
- **每次执行重读全量**。同一份 snapshot 反复进估算、反复进 trim。
- **真改文件能力是另一套**。codex / claude_code adapter 真改文件靠把 `cwd=用户目录` 交给 CLI（`codex-runtime-adapter.service.ts:49-56`），CLI 自己 Read/Grep。等于一个项目里跑着两套互不通气的"理解项目"机制。

### 1.3 成熟 Agent（Claude Code / Codex）的做法

进会话时不预扫；给路径就够。Agent 有 `Read(file)` / `Grep(pattern)` / `Glob(pattern)` / `Bash(ls)` 这组工具，按需现场拿。看完即弃，工具结果用完滑出窗口。50 万行仓库可能只摸过 200 行。

参考已有文档：
- `docs/design/codex-style-agent-collaboration-architecture-v1.md` — 提出过同方向的高层主张。
- `docs/design/context-router-target-design-v1.md` — `ContextRouter` 已有"按任务选证据"的雏形。
- `docs/ai-agent-context/pluggable-engineering-runtime-memory.md` — 可插拔 runtime 长期记忆。

本文档专注落地：**讨论阶段保留 Push、执行阶段切 Pull**。

## 2. 目标与非目标

### 2.1 目标

- **G1**：执行阶段（task_acceptance / task_execution）的 Agent 通过工具按需读文件，不再依赖预灌的全量 snapshot。
- **G2**：讨论阶段（AGENT_DISCUSSING）继续按现有 Push 流程跑，**只扫"门面"文件**（package.json / README / tsconfig / 顶层目录结构），讨论 token 体积下降一个数量级。
- **G3**：codex / claude_code adapter 已有的"CLI 自己读写"行为不变；新增工具仅服务于 generic_llm runtime。
- **G4**：所有工具调用走现有 Capability Registry 与事件流，群聊可视化能看到"哪个 Agent 读了哪个文件"。
- **G5**：跨 Agent 文件读取结果在会话级缓存，避免同一 path 重读。

### 2.2 非目标

- 不重写 ContextPack / ContextRouter / EngineeringRuntime 合同。
- 不替换 codex / claude_code adapter 的内部实现（它们本就是 Pull）。
- 不动数据库 schema；缓存仅会话内存级。
- 不做完整 RAG embeddings/pgvector（仍是后续计划）。
- 飞书 / MCP / Human runtime 维持后续计划状态。

## 3. 设计原则

1. **正交，不替换**：新工具走现有 Capability + Runtime 通道，不引入新概念。
2. **最小工具集**：先上 `read_file` / `list_dir` / `grep_search` 三个；后续按真实诉求加。
3. **服务器侧执行**：工具实现在后端 NestJS 内，复用 `workspace-scanner.ts` 已有的路径校验和敏感文件过滤；不在浏览器跑。
4. **可审计**：每次工具调用产生 `capability_invocation` 事件 + `runtime_invocation` 关联，群聊可视化看到。
5. **保护写盘**：本设计**仅扩展读路径**。写文件继续走 codex / claude_code 自身的真实 CLI 流程或现有 fileChanges 写回链。读和写分开。

## 4. 总体架构

```
+------------------ 讨论阶段 (现有 Push, 收紧版) ------------------+
| 前端 createSession                                              |
|   └─ scanDirectory(handle)                                       |
|        └─ 仅读"门面"文件: package.json / README / tsconfig /    |
|           顶层 tree (深度 2)                                     |
|        └─ workspaceSnapshot.files = 门面内容                     |
| 后端 OrchestratorService.discussAndCreateBrief                   |
|   └─ ContextPack 含轻量 snapshot, 现有裁剪足够                   |
+------------------------------------------------------------------+

+------------------ 执行阶段 (新 Pull 模式) -----------------------+
| OrchestratorService.runOneTask(generic_llm)                      |
|   └─ ContextPack 不再含全量 snapshot                             |
|   └─ ContextPack.availableTools += [read_file, list_dir,         |
|       grep_search]                                               |
|   └─ Agent 输出 tool_use → RuntimeService 派发                   |
|        └─ WorkspaceToolService.invoke(...)                       |
|             ├─ safeJoin (复用 server-file-changes.ts)            |
|             ├─ isSensitivePath (复用 workspace-scanner.ts)       |
|             ├─ WorkspaceCache 命中? 直接返回                     |
|             └─ fs 读真磁盘                                       |
|   └─ 工具结果作为下一回合的 contextPack.toolResults 注入         |
|                                                                  |
| codex / claude_code runtime 路径不变 (CLI 自己 Read/Grep)        |
+------------------------------------------------------------------+
```

## 5. 数据合同变更

### 5.1 ContextPack 字段（新增，不影响现有字段）

`packages/shared/src/contracts.ts`：

```ts
export type WorkspaceToolName = 'read_file' | 'list_dir' | 'grep_search';

export type WorkspaceToolDescriptor = {
  name: WorkspaceToolName;
  description: string;
  schema: object; // JSON Schema for input
};

// ContextPack 新增字段
availableTools?: WorkspaceToolDescriptor[];
toolResults?: Array<{
  callId: string;
  toolName: WorkspaceToolName;
  input: Record<string, unknown>;
  output: string;       // 文本截断
  errorMessage?: string;
  truncated: boolean;
  invokedAt: string;
}>;
```

讨论阶段不下发 `availableTools`，行为不变。
执行阶段对 generic_llm runtime 下发，对 codex/claude_code runtime 不下发（它们走自己的 CLI 工具）。

### 5.2 工具输入输出

- `read_file({ path, startLine?, endLine? })` → 文本，最大 32KB，过敏感文件返回错误。
- `list_dir({ path, depth=1 })` → 名称数组，最大 200 项；过滤 `.git/node_modules/dist/build`。
- `grep_search({ pattern, path?, maxResults=50 })` → `[{ path, line, snippet }]`；正则受限（无回溯灾难），单次最大 50 命中、单 snippet ≤ 200 字符。

### 5.3 事件

复用现有事件类型，不新增：
- 工具调用 → `capability_invocation`（已有）。
- 工具失败 → `error_reported`（已有）。
- Agent 工具调用本身 → `runtime_invocation` 的 sub-step（已有 invocation 概念，扩 metadata）。

## 6. 关键模块改动清单

### 6.1 新增

| 文件 | 责任 |
| -- | --- |
| `apps/server/src/modules/runtimes/workspace-tools.service.ts` | `read_file/list_dir/grep_search` 三方法的真实 fs 实现，复用 `safeJoin`/`isSensitivePath`，单次输出大小限制 |
| `apps/server/src/modules/runtimes/workspace-tool-cache.service.ts` | 会话级内存缓存：key=`${sessionId}::${path}::${normalizedArgs}`，LRU 上限 64 项 |
| `apps/server/src/modules/capabilities/default-capabilities.ts` | 新增 `cap-read-file`/`cap-list-dir`/`cap-grep-search`（riskLevel=low） |
| `packages/shared/src/contracts.ts` | 新增 `WorkspaceToolName` / `WorkspaceToolDescriptor` 类型 + `availableTools`/`toolResults` 字段 |

### 6.2 修改（最小侵入）

| 文件 | 改动 |
| -- | --- |
| `apps/server/src/modules/runtimes/generic-llm-runtime.service.ts` | LLM 输出 `tool_use` 时调 `WorkspaceToolService`，把结果作为下一回合 `toolResults` 拼回 prompt；最多 N 轮（默认 5）防失控循环 |
| `apps/server/src/modules/orchestrator/orchestrator.service.ts` | 执行阶段 `createContextPack` 对 generic_llm runtime 注入 `availableTools`；**仍保留** workspaceSnapshot 但只放 tree（不放 files.content） |
| `apps/web/src/stores/localWorkspace.ts` | 新增"轻扫"模式：仅读 `package.json/README*/tsconfig*/*.config.*` + 顶层 tree 深度 2；总量目标 ≤ 50KB。讨论阶段用此模式，执行阶段不再依赖前端预扫的内容 |

### 6.3 不动

- codex / claude_code adapter（继续真实 CLI）
- 前端文件写回审阅（已做完）
- 状态机 / 死锁修复（已做完）
- 飞书 / MCP / Human runtime（后续计划）

## 7. 工作流时序

### 7.1 讨论阶段（现有，仅收紧扫描）

```
User -> Web: 选目录, 输入任务
Web: 轻扫 (门面文件 + 顶层 tree)
Web -> Server: POST /sessions { workspaceSnapshot(轻量) }
Server: AGENT_DISCUSSING -> Coordinator + 各 Agent 讨论 -> brief
```

token 体积：从当前最多 80 文件 × 80KB ≈ 6MB 字符 → 控制在 50KB 量级。

### 7.2 执行阶段（新 Pull）

```
brief 确认 -> EXECUTING
runOneTask(agent=backend, runtimeType=generic_llm)
  ContextPack: 系统规则 + 任务 + brief + 轻量 tree + availableTools
  Agent LLM 第 1 轮: tool_use{ list_dir, path:"apps/server/src" }
  WorkspaceToolService -> 返回 ["modules", "common", "main.ts", ...]
  Agent LLM 第 2 轮: tool_use{ read_file, path:"apps/server/src/modules/.../foo.ts" }
  WorkspaceToolService -> 返回 文件内容(最多32KB)
  Agent LLM 第 3 轮: tool_use{ grep_search, pattern:"applyOutcome" }
  Agent LLM 第 4 轮: 输出 stage_artifact / fileChanges
runOneTask 结束
```

整个过程：每一步 LLM 输入只含**这一回合需要的工具结果**，不是整个项目。

## 8. 风险与缓解

| 风险 | 缓解 |
| -- | --- |
| LLM 不会用工具/瞎调用 | systemPrompt 明确工具语义；最多 5 轮工具循环上限；超限自动转 ask_user |
| 文件读写权限误用 | 全部走 `safeJoin` + `isSensitivePath` + low-risk capability；写不在本工具集 |
| 缓存导致脏读 | 缓存按 mtime 失效；写回路径触发同 path 缓存清除 |
| 跨 runtime 行为不一致 | codex/claude 仍用自身 CLI；只 generic_llm 走新工具，差异由 ContextPack.availableTools 是否存在显式区分 |
| 单次 grep 返回过大 | maxResults=50、snippet ≤ 200 字符、总输出 ≤ 16KB |
| 大目录场景仍超 token | 不再可能：每回合只塞一次工具结果，工具自身大小已限上限 |

## 9. 不打算做

- 删除 `fitContextToBudget` 6 级裁剪。Push 流程的讨论阶段还要它兜底。
- 让 codex / claude_code 也用本工具集。它们 CLI 自带，重复造轮子无益。
- 做 RAG / embeddings。本设计是工程级"工具读文件"，不是语义检索。要做 RAG 走另立设计。

## 10. 验收标准

完工 = 同时满足：

1. **A1**：350+ 文件目录创建会话不再因 token 失败；e2e `npm run test:e2e:main-chain` 仍绿。
2. **A2**：执行阶段 generic_llm Agent 在调试视图能看到至少 2 次 `read_file` 或 `grep_search` 调用，且任务能 `delivered`。
3. **A3**：codex / claude_code runtime 行为不变（已有 stub e2e 仍绿）。
4. **A4**：讨论阶段 ContextPack 中 `workspaceSnapshot.files` 平均字节数较改造前下降 ≥ 80%（debug API 取样验证）。
5. **A5**：新增 e2e：`tests/e2e/workspace-tools-pull-smoke.mjs` 跑通"Agent 读两个文件并改一个文件"链路。

## 11. 排期与拆分（仅供讨论参考，不承诺）

| 阶段 | 内容 | 验收 |
| -- | --- | --- |
| Stage 1 | 后端 WorkspaceToolService（含安全边界 + 三方法） + 单元测试 | tools 单测全绿 |
| Stage 2 | generic_llm runtime 集成 tool_use 循环 | 一个手写脚本能让 Agent 调到 read_file |
| Stage 3 | ContextPack `availableTools/toolResults` 合同 + ContextRouter 接入 | typecheck + harness 不退化 |
| Stage 4 | 前端轻扫模式 + 讨论阶段 token 验证 | A4 |
| Stage 5 | 端到端 smoke + 现有 e2e 全绿 | A1/A2/A3/A5 |

## 12. 待对齐的问题

- **Q1**：5 轮工具循环上限合不合理？还是按 token 累计上限更稳？
- **Q2**：discussion 阶段的"门面文件"清单要不要做成 env 配置？
- **Q3**：generic_llm 调外部 OpenAI 兼容端点时，是用 OpenAI 的 `tools` 协议还是自定义文本协议？前者依赖端点支持。
- **Q4**：要不要给现有内置 `architect`/`backend` 等预设 agent 默认绑上新增的 `cap-read-file/list-dir/grep-search`？还是新建 capability、要求用户手动勾选？
- **Q5**：Agent 调用工具失败（路径不存在/越界）后，是直接把错误塞回 toolResults 让模型自己重试，还是中止任务？

## 13. 独立评审记录（2026-06-18）

由独立 code-reviewer 代理对照源码做的盲审，全部带行号验证，结论照录。**未在本设计内修改，待人决定取舍。**

### 13.1 评分

| 维度 | 分数 |
| --- | --- |
| 方案方向正确性 | 8/10 |
| 设计严谨度 | 5.5/10 |
| 落地可执行性 | 6/10 |

总评：**方向批，设计层面请求修改**。

### 13.2 必须在 Stage 2 上线前补的三块

1. **workspaceFocus / projectMap 在轻扫模式下的退化链**。`orchestrator.service.ts:3115-3122` 的 `workspaceFocus` 完全靠 `snapshot.files` 排序计算；`createContextPack` 调用链（`:1873-1989`）全部依赖 `session.workspaceSnapshot.files`。前端切到轻扫后 relevantFiles / projectMap / workspaceFocus 会塌到只剩 README/package.json，下游 `taskContext.evidenceSelection`、`workspaceEvidenceContent`（`:2095+`）质量同样退化。本设计第 6.2 节只写"snapshot 仅放 tree"，未回答这条。
2. **BullMQ 模式下事件流断裂 + Recovery 续跑丢工具历史**。`recovery.service.ts:33` 显示 `ENABLE_BULLMQ=true` 时由队列 worker 进程接管；进程内的 `WorkspaceToolCacheService` 跨进程不共享，命中率失效。`capability_invocation` 事件如何从 worker 回写主进程 SSE，本设计未提。`recovery.service.ts:42-54` 重启时只重新 `execution.start(...)`，工具循环已跑过的若干轮全部丢失重跑——必须把 toolResults 落 artifact 或 event 才能续跑。
3. **isSensitivePath 黑名单扩展 + symlink 防护 + 双保险预算**。当前黑名单只挡 `.env*/secret/private-key/.pem/.key/.p12/.crt`；Pull 模式下模型可主动请求 `~/.ssh/id_rsa`、`.npmrc`（含 npm token）、`.aws/credentials`、`.docker/config.json`、`.gitconfig`、`.git/config`，全部不在黑名单。`safeJoin` 当前只做 path resolve 比较，未 lstat 判断 symlink，Unix 上一个符号链接即可越界。5 轮上限单一保险不够：32KB×5≈40K tokens 工具输出已是常态，建议加 token 累计上限（默认 60K）+ 总工具调用次数上限（默认 12 次）。

### 13.3 现状描述需要修订

- 文档把"前端递归扫"指向 `localWorkspace.ts:208-292`，真正的扫描循环在 `:80-83 + :267-351`。行号修正。
- 文档说"直接复用 `safeJoin`/`isSensitivePath`" —— 这两个函数是模块内 private，未 export。要复用必须先抽 `apps/server/src/common/path-safety.ts`。

### 13.4 generic_llm 加 tool_use 循环的暗坑（保守 5–8 人天）

- `generic-llm-runtime.service.ts:162` 的 systemPrompt 写死 `"Do not call tools, modify files, or perform external side effects"`。
- `:201` 强制 `response_format: { type: 'json_object' }`，与 tool_use 互斥。
- timeout 是 per-attempt（`:147`），5 轮串行的累计 timeout 要重做。
- OpenAI 兼容端点的 `tools` 协议在 Qwen/DashScope/Ollama 行为差异大（已在 Q3 提出，未决）。
- 退出条件：模型不调工具直接出答 / 调不存在工具 / 工具相互依赖，每条都需 dispatcher 层补，本设计第 8 节未拆。

### 13.5 LLM 输出异常的兜底缺口

- 调不存在工具：dispatcher 应把 `unknown_tool` 塞回 toolResults 并 emit `error_reported`，本设计未规定。
- 参数 schema 错：JSON Schema 校验失败应回 toolResults，限制重试次数。本设计未规定。

### 13.6 其他被遗漏的盲点

- **跨平台路径**：合同未规定工具入参 path 必须 forward-slash 归一化；Windows 模型大概率传 `apps\server\...`。
- **二进制/大文件**：`read_file` 32KB 上限对文本够用，但读 PNG/二进制流没先用 `shouldReadTextFile` 判定，会返回乱码占 token。
- **缓存竞态**：多 Agent 并发同 session 时"agent A 清缓存 + agent B 同时读"的 race 未解；Windows 大小写不敏感的 path 归一化没说，会出现缓存重复条目。
- **ContextPack 字段扩展冲击面**：`packages/shared/src/contracts.ts:682-734` 是 700+ 行的合同；至少 5 个 e2e 与 `DebugRuntimeView.vue` / `debug.controller.ts` 是消费方。本设计第 5.1 节未列冲击面清单。

### 13.7 排期可优化

Stage 4（前端轻扫）与 Stage 1/3 完全独立，可与之并行；Stage 5 (e2e) 仍依赖 1/2/3 收口。

### 13.8 需要决策的事项（在动手前请你定）

1. workspaceFocus / projectMap 在轻扫模式下怎么生成？
   - **方案 A**：服务端首轮先调 list_dir + read_file 几个门面文件，自己生成轻量 ProjectMap（保留可视化）。
   - **方案 B**：直接让 Agent 在工具循环里现场推断（最纯 Pull）。
2. BullMQ + Recovery 工具历史怎么落？
   - **方案 A**：每次工具调用写入 `runtime_invocation.subSteps`（已有数据通道，扩字段）。
   - **方案 B**：单独建 `tool_invocations` 表，按 task 持久化。
3. tool_use 协议选哪种？
   - **方案 A**：跟 OpenAI `tools` 标准（生态好，但 Qwen/Ollama 兼容差）。
   - **方案 B**：自定义文本协议（统一各端点，但 prompt engineering 成本高）。
4. 把它放在更小的 PoC 先跑通，还是直接按 Stage 1–5 全做？
