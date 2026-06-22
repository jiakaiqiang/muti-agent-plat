# Agent Cluster 团队综合分析：目录读取与文件修改闭环

> 生成时间：2026-06-18
> 分析方式：虚拟专家团队多视角并行查证 + 主 Agent（协调者）综合
> 团队成员：架构设计师、软件系统专家、前后端 Agent 应用专家、产品经理
> 目标能力：Agent 能读取用户选择目录里的文件，并能按需求真实修改这些文件
> 验证方式：逐文件读源码，所有结论带 file:line 证据，不依赖文档自述

## 0. 一句话结论

「读取目录 + 修改文件」这条链路**主体已经真实打通**，不是 mock。卡点不在于「没实现」，而在于**默认全关 + 没有 UI 入口 + 没有逐文件审阅**——也就是能力齐了，但用户在界面上点不出来、也不敢放心用。

## 1. 现状：闭环到底通不通（软件系统专家 + 前端专家）

### 1.1 读取目录 —— 真实，两条独立路径

- **浏览器路径（前端唯一实现）**：用 File System Access API `showDirectoryPicker`，选目录时申请 readwrite 权限，递归 `handle.entries()` 读真实文件内容，生成 `workspaceSnapshot`（含 `files[].content`），随 `POST /sessions` 上传。
  - `apps/web/src/stores/localWorkspace.ts:314-329`（选目录）、`:208-292`（扫描读内容）、`packages/shared/src/contracts.ts:160-170`（snapshot 结构）。
- **server-local 路径（仅后端实现）**：从用户输入文字正则抽取绝对路径，后端用 `node:fs` 直接 `readdir`/`readFile`。
  - `apps/server/src/common/workspace-scanner.ts:126-130`、`:20-124`。
- **限额与脱敏**：最多 350 条目 / 80 个文本文件 / 单文件 80KB / 总量 550KB；`.env`/`*.pem`/`*.key`/含 secret 文件跳过不读。
  - `workspace-scanner.ts:15-18,136-139`；前端同款 `localWorkspace.ts:69-72,139-151`。

### 1.2 修改文件 —— 真实，但分真改/假改两类

| 写回路径 | 是否真改用户源文件 | 证据 |
| --- | --- | --- |
| codex / claude CLI 在 `cwd=用户目录` 直接落盘 | **是**，CLI 真改 | `codex-runtime-adapter.service.ts:49-56`；`claude-code-runtime-adapter.service.ts:47-69` |
| 后端 `applyServerLocalFileChanges` 写回 | 仅 `agent-output/` 或 `source=actual_filesystem_snapshot` 且开关开 | `server-file-changes.ts:5-16`；`orchestrator.service.ts:1810-1853` |
| 前端 `createWritable()` 写回浏览器选的目录 | **是**，需用户点「确认写入」+ readwrite 授权 | `localWorkspace.ts:114-131,381-426`；`SessionWorkspace.vue:520-529` |
| mock runtime 的源文件变更 | **否**，只能写 `agent-output/` 占位 markdown | `mock-runtime.service.ts:1177-1209`，被 `orchestrator.service.ts:1818-1822` 过滤 |

### 1.3 安全防护 —— 部分到位

- **路径逃逸防护**：有。后端 `safeJoin` 校验结果必须在 root 内（`server-file-changes.ts:18-25`）；前端 `safePathParts` 拒绝 `..`（`localWorkspace.ts:87-96`）。
- **覆盖冲突检测**：后端有（`assertNoUnexpectedOverwrite`，`server-file-changes.ts:27-55`，但仅当变更带 `previousContent` 时生效）；**前端没有**，一键全量覆盖，`previousContent` 字段在写盘路径里完全没用上（`localWorkspace.ts:127-129`）。
- **逐文件确认**：两端都没有。确认粒度是「能力级一次性批准」（session:agent:capability），不是 per-file。
- **事务/回滚**：没有，写盘失败发 `error_reported` 事件并中止本批，非原子。

## 2. 可配置化现状（架构设计师）

### 2.1 默认团队已是「可编辑列表」

- 内置 10 个角色，集中在 `packages/shared/src/default-agent-presets.ts:17-278`，注释明确「编辑此列表增删/重排」。
- 现有角色：coordinator、requirements、architect、frontend、backend、test、review、notification、product-manager、ui-designer。
- 有创建/更新 Agent 的 API（`agents.controller.ts:19-27`），前端 `AgentManager.vue` 可建可改、可勾选 capability。**无删除 Agent 路由。**

### 2.2 主 Agent（Coordinator）—— 半写死

- orchestrator 全程用 `pickSessionAgent(session, ['coordinator'])` 按**固定字符串 key**选主 Agent（`orchestrator.service.ts:101,422,863,953`）。
- 可配置的只是「哪些 Agent 参与会话」；**主 Agent 身份不能配置成别的 key**，参与者里没有 `coordinator` 时静默退回列表第 0 个（`:3460`）。

### 2.3 运行时切换 —— 后端通，前端断

- 优先级链已实现：agent override > session > project > global（`orchestrator.service.ts:3372-3427`）。
- session 创建可带 `engineeringRuntimeType`（后端 `sessions.controller.ts:29-30`、`sessions.service.ts:831-846`）。
- **但前端没有接线**：创建会话只传 `input/agentIds/workingDirectory/workspaceSnapshot/tokenBudget`，不传 runtime（`SessionWorkspace.vue:205-211`）；AgentManager 不含 runtimeType 输入控件。
- 结果：**切到 codex 目前只能改环境变量或手搓 API 请求体，界面上点不出来。**

## 3. 关键阻碍：一个新角色要真正能改文件，差什么（综合）

以「架构设计师」这类新角色为例，要真正落到改文件，需同时满足 4 个条件，当前各有卡点：

1. **Agent 要有 `cap-file-write`** —— 内置 architect 只有 `['cap-brief','cap-dry-run']`，不含写权限（`default-agent-presets.ts:83`）。只有 frontend/backend 默认带 `cap-file-write`。
2. **effective runtime 必须是 codex / claude_code** —— 但 `defaultAgentRuntimeType()` 白名单只允许 `mock/generic_llm`（`runtime-config.ts:7-8`），预设全是 `generic_llm`，且 `agents.service.ts:38` 对默认 key 的 Agent 强制覆盖 runtimeType。切 codex 实际只能靠 session/project/global 配置，而那又没 UI（见 2.3）。
3. **任务要派到该 Agent** —— 靠 brief 产出的 `suggestedAgentKey` 匹配，否则兜底落到 `backend`（`orchestrator.service.ts:423`、`tasks.service.ts:26`）。
4. **高危能力默认需用户批准** —— `cap-file-write` 是 high risk（`default-capabilities.ts:50`），`checkInvocation` 默认 `allowed=false`，预检阶段把任务挂 `waiting` 直到批准（`capabilities.service.ts:63-78`、`orchestrator.service.ts:426-444`）。

加上两个运行时开关默认全关：`CODEX_RUNTIME_ENABLED`、`CLAUDE_CODE_ENABLED` 默认 `!== 'true'` 即拦截（adapter `:30`）。

## 4. 产品视角的核心问题（产品经理）

PRD 承诺的是「像管理一个 Agent 工作群一样，提需求、确认、观察执行、拿到改好的代码」。从用户旅程看，断点不在引擎，在体验：

1. **用户选了目录，却没有界面开关让 Agent 真正去改它。** 真改文件的能力被三道默认关闭的闸门（runtime 开关、cap-file-write 批准、defaultAgentRuntime 白名单）挡着，而打开这些闸门的入口在环境变量里，不在 UI 上。普通用户走不到「修改文件」这一步。
2. **写回是一键全量覆盖，没有 diff 确认。** 前端 diff 只在聊天流里展示（`ChatTimeline.vue:620-637`），和「确认写入」按钮不联动。用户无法逐文件审阅再决定写哪个。对「改我本地代码」这种高风险操作，这是信任硬伤。
3. **codex 这条最强的真实代码代理，用户在界面上选不到。** 后端能力完整，前端零入口，等于白做。
4. **mock 会误导。** 默认 runtime 下 Agent 只往 `agent-output/` 写占位 markdown，用户以为「改了代码」，其实源文件没动。

## 5. 后续发展方向与解决思路（切合实际，按性价比排序）

原则：**先把已有能力接到 UI 上（低成本高价值），再补审阅安全（中成本），最后才碰新引擎（高成本）。** 不发散、不重写。

### P0 —— 让已有能力可达（纯接线，不动引擎）

| 方向 | 具体改动点 | 价值 |
| --- | --- | --- |
| 会话创建加 runtime 选择控件 | `SessionWorkspace.vue:205-211` 把 `engineeringRuntimeType` 传进 `createSession`；store 类型已声明（`session.ts:23-24`） | 用户能选 codex/claude，打通最强路径 |
| Agent 编辑加 runtime + 能力开关 | `AgentManager.vue` 创建/更新 payload 补 `runtimeType`；capability 勾选已有 | 让「架构设计师」这类角色能配成可改文件 |
| 高危批准做成确认卡 UI | 复用现有 confirmation card 机制，把 `cap-file-write` 的 `CAPABILITY_REQUIRES_CONFIRMATION` 暴露成可点确认 | 把「挂 waiting」变成用户可见可批准 |

### P1 —— 写回安全与可信（中成本）

| 方向 | 具体改动点 | 价值 |
| --- | --- | --- |
| 写回前 diff 预览 + 逐文件 apply/skip | 把 `ChatTimeline` 的 diff 渲染搬到「确认写入」弹窗，前端写盘循环（`localWorkspace.ts:409-411`）支持按 path 过滤 | 解决「一键全量覆盖」信任硬伤 |
| 前端补冲突检测 | 写盘前用已存在的 `previousContent` 字段比对当前磁盘内容（后端已有同款逻辑可参照 `server-file-changes.ts:27-55`） | 防止覆盖用户期间手改的文件 |
| mock 行为明示 | mock 产出的源文件变更在 UI 上标注「演示，未真实写入」 | 消除「以为改了其实没改」的误导 |

### P2 —— 引擎与生产化（高成本，排期）

| 方向 | 说明 |
| --- | --- |
| codex/claude 隔离 worktree + 超时/取消一致性 + 命令白名单 + 审计日志 | adapter 已能真实调 CLI，缺的是生产级隔离与可观测 |
| server-local 模式前端入口 | 类型已留 `server_local`，前端未实现选择入口（`localWorkspace.ts:78-85` 写死 browser_local） |
| 主 Agent 可配置 | 把 `pickSessionAgent(['coordinator'])` 的固定 key 改为会话可指定的「主 Agent id」 |

### 暂不实现（已确认，列入后续计划）

- 飞书 connector（当前仅草稿生成器）
- MCP Tool Runtime（仅合同类型）
- Human Runtime（仅合同类型）

## 6. 待你拍板的问题

1. **P0 接线**是这次最高性价比的事（后端能力都在，只差前端几处传参）。要不要我先就「会话创建 runtime 选择 + Agent runtime/能力配置」出精确到行的改动方案？
2. 主 Agent 可配置（把 coordinator 从写死 key 改成可指定）属于编排改动，影响面比接线大，确认是否纳入本轮，还是先 P2 排期？
3. 写回安全（diff 确认 + 逐文件 apply）是信任硬伤，但工作量中等，确认优先级排在 P0 接线之后？

> 本报告仅做诊断与方案建议，未改动任何业务代码、未提交。
