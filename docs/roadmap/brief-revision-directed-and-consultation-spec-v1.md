# 任务契约「定向修订 + 持续探讨」修改计划 Spec v1

状态：待实现（本文档只描述方案，不含已落地代码）
日期：2026-07-20
范围：修复「修改契约后多 Agent 讨论不采纳用户修改」的 bug，并新增「定向 Agent 修订」与「契约持续探讨」两个能力。

---

## 1. 背景与根因

用户在任务契约（TaskBrief）卡片上点「要求修改」，编辑后提交，多 Agent 重新讨论时**继续输出修改前的内容**，未采纳用户的修改。

经代码追踪确认根因（叠加）：

1. **权威目标永不更新**：每个 Agent 上下文 L1 的 `sessionGoal = session.originalInput`（`orchestrator.service.ts:2969` → `build-envelope-from-context-assembly.ts:62`）。而 `session.originalInput` 全仓库只在建会话时赋值一次，之后从不更新。用户改契约后，Agent 看到的「总目标」仍是最初的原始输入。
2. **修改内容只降级为一条 memory，且只发给 coordinator**：`reviseBrief` → `reopenRequirementLoop` → `recordAgentRequirementContext`（`sessions.service.ts:1559`）把用户文本写成 session memory；`relevantAgentIds` 在 revision 场景只含 coordinator，其他讨论 Agent 按 `agentId` 过滤搜不到。
3. **即便 coordinator 也靠关键词搜索命中才进 prompt**：讨论阶段 `createContextAssembly` 的 memory 检索 query 只有 `session.originalInput`（brief/task 均 undefined，`orchestrator.service.ts:2918-2922`），用户新增词汇越多越召不回。
4. **旧契约信号反被稳定带回**：重开讨论时上一版 brief 仍在 `briefsBySession`、`brief_created` 事件仍在流里，`createSummaryMemory` / `decisionEvents` 会把旧 goal/decisions 拉进上下文（`orchestrator.service.ts:4127-4173`）。
5. **无「按请求指定 Agent 参与」机制**：讨论参与者由 `discussionParticipants` 决定，唯一能收窄的是进程级环境变量 `DISCUSSION_AGENT_KEYS`；`affectedAgentIds` 只用于写 memory/状态事件，不影响实际参与名单。

一句话：修改契约走的是「把改动降级成自由文本 → 存 memory → 全员重新自由讨论」，而不是「以用户修改后的契约为权威基线 → 定向增量修订」。

补充事实：
- 没有独立的「接受者」runtime 角色。默认 Agent `coordinator` 的中文名即「接收者」（`default-agent-presets.ts:21`），它就是讨论后跑 `brief_generation` 的汇总者。「交给接受者总结」= 让 coordinator 定稿，无需新造角色。

---

## 2. 已确认的产品决策

1. **修改弹窗**：保留单个 textarea（不做结构化表单）。textarea **预填当前契约全文**（沿用 `formatBriefForRevision`），用户在其上直接编辑。这段内容语义是「用户修改后的契约 / 问题回复」，提交后交给**用户指定的 Agent** 处理，再由接收者（coordinator）总结。
2. **目标字段**：**新增 `latestContractGoal` 字段并保留 `originalInput`**。每次讨论产出新契约时把 `latestContractGoal` 同步为最新 `brief.goal`；Agent 上下文 L1 **同时注入两者**（原始需求 + 当前权威目标）。`brief.goal` 本身每次重新讨论都是最新值。
3. **指定 Agent**：修改弹窗新增「指定处理 Agent」多选。选中的 Agent 针对用户修改做定向修订，未选时直接由 coordinator 定稿，不再全员重跑。
4. **持续探讨**：契约生成后，用户可 @ 具体 Agent 就当前契约反复对话打磨；单 Agent 应答、不触发重跑，可随时定稿或把建议采纳进契约。

---

## 3. 分阶段计划

### P0 —— 修复「改了不采纳」（最小改动、独立可交付）

目标：让用户修改后的契约成为 Agent 的权威目标，压低旧契约信号。不改交互，仅修上下文组装。

改动点：

1. `packages/shared/src/contracts.ts`
   - `SessionDetail` 新增可选字段 `latestContractGoal?: string`（紧邻 `originalInput`）。
   - `ContextL1Invocation`（`:486`）新增可选字段 `currentContractGoal?: string`。
   - `ContextAssembly`（`:1611`）新增可选字段 `currentContractGoal?: string`。

2. `apps/server/src/modules/orchestrator/orchestrator.service.ts`
   - `discussAndCreateBrief` 生成 brief 后（`:250` 附近），把 `session.latestContractGoal = brief.goal` 并持久化 session。
   - `createContextAssembly`（`:2908`）：
     - 设 `currentContractGoal = session.latestContractGoal ?? brief?.goal`。
     - memory 检索 query（`:2918`）追加 `session.latestContractGoal`，保证用户修改后的目标词汇参与召回。
   - `reviseBrief` 场景重跑讨论前，把用户修改文本无条件纳入上下文（不只靠搜索）：可在 `createContextAssembly` 里对 `phase in ('discussion','brief_generation')` 也纳入最近 N 条 session memory（参照 `task_execution` 的 `recentAgentSessionMemories` 逻辑，`:2923`）。

3. `apps/server/src/modules/context-v2/build-envelope-from-context-assembly.ts`
   - L1（`:61`）新增 `currentContractGoal: contextAssembly.currentContractGoal`。
   - `summaryBullets`：把 `currentContractGoal` 作为置顶 bullet，明确标注「当前权威目标（用户已修改，以此为准）」，高于旧 brief decisions。

4. `apps/server/src/modules/sessions/sessions.service.ts`
   - `reopenRequirementLoop`：把上一版 brief 标注为「待废弃旧版本」（可通过一个状态事件或在 summary 里降低其权重），避免旧 goal 被 `createSummaryMemory` 拉回。

验证：`npm run typecheck`、`npm run test:e2e:requirement-revision-loop`、`npm run test:e2e:browser-brief-revision`、`npm run test:e2e:multi-agent-discussion`。

回退：以上均为新增字段 + 上下文组装调整，不改交互与状态机，可整段还原。

---

### P1 —— 定向 Agent 修订 + 接收者总结

目标：修改契约时不再全员重跑，改为「用户改 → 指定 Agent 增量修订 → coordinator 定稿」。

数据契约（`packages/shared/src/contracts.ts`）：
- 扩展 revise 请求体：
  ```ts
  type BriefRevisionRequest = {
    userMessage: string;          // 预填契约全文 + 用户编辑后的文本
    assignedAgentKeys?: string[]; // 用户指定的定向 Agent；空 = 只让 coordinator 定稿
    confirmationId?: string;
    reason?: string;
  };
  ```
- 新增 phase 常量 `brief_revision`（若 `AgentRunPhase` 尚无）。

后端（`sessions.service.ts` + `orchestrator.service.ts`）：
1. `sessions.controller.ts` 的 `rejectBrief` 透传 `assignedAgentKeys`。
2. `reviseBrief` 分流：
   - 有 `assignedAgentKeys` → 走新 `reviseBriefDirected` 分支，不调 `reopenRequirementLoop` 的全量重跑。
   - 无 → 保留现有全量流程作为回退。
3. `reviseBriefDirected`：
   - 以用户修改文本为权威基线，`session.latestContractGoal` 同步更新。
   - 仅对 `assignedAgentKeys` 对应的 Agent 各跑一轮 `brief_revision`，上下文显式注入「基线契约 + 用户修改说明 + 旧/新 diff」，提示词强调「用户修改是已确认基线，只做增量修订，不得推翻」。
   - 收集各 Agent 意见后，coordinator（接收者）跑 `brief_generation` 定稿，产出新版本 brief，回到 `WAIT_USER_CONFIRM`。

前端（`SessionWorkspace.vue` + `stores/session.ts`）：
- 修改弹窗底部新增「指定处理 Agent」多选，数据来自 `participatingAgents`，默认不选。
- `store.reviseBrief` 提交 `assignedAgentKeys`。

验证：同 P0 三个 smoke + 新增定向修订用例；`npm run typecheck`。

---

### P2 —— 契约持续探讨

目标：契约生成后进入可对话打磨状态，用户 @ 单个 Agent 反复讨论，不触发重跑，可随时定稿。

后端：
1. 新增 phase `brief_consultation`。
2. `WAIT_USER_CONFIRM` 下用户发带 @Agent 的消息走轻量探讨分支（不进 `correction` 全量重跑）：只调被 @ 的单个 Agent 一次，上下文注入当前契约全文 + 本轮探讨对话历史（按 `relatedBriefId` 过滤，不走 `slice(-12)`），以 `agent_message` 回复，**不修改契约**。
3. 用户可点「采纳到契约」→ 复用 P1 的定向修订把建议落成新版本。

前端：
- 契约卡片新增「和 Agent 探讨」入口（聊天框 + @ 选择）。
- 「确认」按钮始终可用，探讨满意即 approve。

验证：新增 browser 探讨 smoke；`npm run typecheck`。

---

## 4. 影响范围与风险

改动文件：
- `packages/shared/src/contracts.ts`（新增字段/请求类型/phase）
- `apps/server/src/modules/orchestrator/orchestrator.service.ts`（上下文组装、定向修订、探讨、目标同步）
- `apps/server/src/modules/sessions/sessions.service.ts`（reviseBrief 分流、状态机）
- `apps/server/src/modules/sessions/sessions.controller.ts`（透传入参、可能新增探讨端点）
- `apps/server/src/modules/context-v2/build-envelope-from-context-assembly.ts`（L1 注入、summary 置顶）
- `apps/web/src/components/SessionWorkspace.vue`、`apps/web/src/stores/session.ts`（弹窗、指定 Agent、探讨入口）

风险与兜底：
- 状态机新增 transition / 新增 phase 会触及 `multi-agent-discussion`、`requirement-revision-loop`、`browser-brief-revision` 三个 e2e，每阶段落地后先跑这三个 + `typecheck`。
- 定向修订、探讨均为新增分支，保留旧 `reopenRequirementLoop` 全量重跑作为回退，降低回归面。
- P0 独立可交付，先修 bug；P1/P2 增量叠加。

## 5. 开发注意（本地环境）

`npm run dev` 的后端不监听源码变更；修改 backend/shared 后显式执行 `npm run dev:restart-server`。该命令只重启后端，Web 和 Local Runtime 保持运行。dev-supervisor 保留 60 秒健康恢复窗口（`READY_HEALTH_FAILURE_LIMIT=30`，每 2 秒探测一次）用于覆盖手动重启时的 shared/server 构建和 Nest 启动；超过窗口仍不可达时才关闭整个进程组并 exit 1。
