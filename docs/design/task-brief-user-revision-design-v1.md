# 用户契约修订送达设计 v1（TaskBrief userRevision）

状态：已设计，未实现（实现代码已于 2026-07-28 按用户要求回退）
适用范围：群聊修订方案后，把用户改动送达指定 Agent 的上下文通道

## 1. 问题

用户在群聊里对生成的任务契约（TaskBrief / 方案）做了修改并提交，Agent 处理完之后，
界面上显示的仍然是修改前的旧方案。

根因：定向修订路径拿到的 `userModification` 只被用于两处——写日志、写事件文本，
**从未注入到 Agent 的运行时上下文**。具体表现：

- `runDirectedBriefRevision` 和 `finalizeBriefRevisionByCoordinator` 都接收
  `userModification: string`，但只拿它拼提示文案和事件内容。
- 被指定的 Agent 拿到的 `taskBrief` 是待修订的旧契约，上下文里没有"用户要求改成什么"。
- 唯一可能让用户改动出现在上下文里的途径是 memory 关键词检索，而检索 query 以
  `session.originalInput` 为主，用户改动的措辞一变就召不回，属于静默漏送。

## 2. 关键约束（来自讨论）

1. **改动要送给被指定的 Agent 处理**，不是只给 Coordinator。用户指定了谁审阅，
   改动就必须进那些 Agent 的上下文。
2. **不能在上下文里重复**。用户是在生成结果的基础上改的，如果把改后的完整契约整体
   追加进去，上下文里会同时存在旧契约和新契约的大量相同内容。
3. **不修改原有字段**。用户提出：修订时新增一个字段承载"改后的建议"，
   原契约字段保持系统生成的原值。

## 3. 设计

### 3.1 新增字段（承载体）

在 `packages/shared/src/contracts.ts` 增加类型，并在 `TaskBrief` 上挂一个可选字段：

```ts
/**
 * 用户在契约卡片上直接编辑出的建议版本。只承载被改动的字段，原契约字段保持
 * 系统生成的原值，便于 Agent 对比"原版 vs 用户改后"并做增量修订。
 */
export type TaskBriefUserRevision = {
  goal?: string;
  scope?: string[];
  outOfScope?: string[];
  constraints?: string[];
  acceptanceCriteria?: string[];
  risks?: string[];
  openQuestions?: string[];
  /** 用户对本次修改的文字说明，也用于兼容纯文本修订入口。 */
  revisionReason?: string;
  revisedAt: ISODateTime;
};

export type TaskBrief = {
  // ...原有字段全部不变...
  /** 仅在该契约进入修订时存在；新版本契约不继承上一版的修订建议。 */
  userRevision?: TaskBriefUserRevision;
};
```

设计要点：

- 全部字段可选，只填用户真正改过的部分。
- 可选字段，旧契约与旧持久化数据无需迁移，向后兼容。
- `RuntimeTaskBrief` 由 `TaskBrief` 派生（`Omit<TaskBrief, 'confirmedByUser' | ...>`），
  新字段自动进入运行时契约，不需要额外改动。

### 3.2 只输出变更字段（解决重复）

新增纯函数模块 `apps/server/src/modules/orchestrator/format-brief-user-revision.ts`：

- 逐字段比对 `brief` 与 `revision`，**只输出真正发生变化的字段**，未改动的字段完全不出现。
- 数组字段按序号渲染，并给出"原版 / 用户改为"两栏对照。
- 导出 `hasBriefUserRevisionContent`，当修订内容与原契约完全相同且无文字说明时不注入。

这样上下文里出现的增量，规模只与用户实际改动量成正比，而不是整份契约的体积。

### 3.3 注入位置与优先级

新增 `injectUserRevisionContext(contextAssembly, oldBrief, userModification)`，
在两条路径上调用：

- 被指定 Agent 的 `brief_revision` 循环内（`createContextAssembly` 之后）
- Coordinator 定稿路径（`finalizeBriefRevisionByCoordinator`）

注入内容分两层，遵循项目既有的上下文分层约定：

- `constraints` 放**指令**：`【用户权威修订】用户对当前任务契约提出以下修改，必须采纳：\n<diff>`
- `systemRules` 放**优先级规则**：
  - `taskBrief` 是被修订的基线，不是目标产物
  - 用户修订是权威的，在基线上做增量应用，未改动部分保持原样
  - 基线与用户修订冲突时，用户修订始终胜出

优先结构化 `userRevision` 的 diff；没有结构化编辑时回落到纯文本 `userModification`。

### 3.4 兜底：memory 白名单

把 `brief_revision` 加入 `includeRecentSessionMemories` 白名单
（原为 `task_execution / discussion / brief_generation / brief_consultation`），
让被指定 Agent 不再依赖关键词检索碰运气。

### 3.5 透传链路

```text
POST sessions/:sessionId/briefs/:briefId/reject   （body 增加 userRevision）
  -> SessionsService.reviseBrief(input.userRevision)
  -> OrchestratorService.attachUserRevision(sessionId, briefId, revision)   // 挂到契约并落库，原字段不变
  -> reviseBriefDirected -> runDirectedBriefRevision -> injectUserRevisionContext
```

## 4. 参考做法

- CrewAI 的 human-in-the-loop 把用户反馈作为**追加上下文**在 `/resume` 时带入，
  而不是改写原任务描述。
- 动态重规划类工作（AutoGPT+P、D-PoT 一类）普遍保留原计划作为基线 + 检查点，
  在其上做增量修正。
- 共同点：把用户纠正当作**结构化数据放进专用上下文槽位**，而不是混进普通对话轮次。
  本设计的 `userRevision` 字段 + 专用注入槽位与此一致。

## 5. 验证情况（回退前实测）

- 格式化模块单测 5/5 通过（注意：本仓库 server 单测用 `node:test` + tsx 运行，
  入口是 `apps/server/scripts/run-unit-tests.mjs`，**不是 vitest**）。
- shared 包 76/76 通过。
- typecheck 全仓 42 个错误，其中属于本设计改动的为 0。
- server 单测 1001 用例 39 失败，失败名单与未改动时完全一致；这 39 个失败均为
  `workflowRuntime?.updates is not a function` / `Workflow runtime is unavailable.`
  的测试替身缺口，属既有问题。

## 6. 未完成部分

1. **前端仍是纯文本**。`apps/web/src/components/SessionWorkspace.vue` 提交修订时只发
   `userMessage`/`confirmationId`/`assignedAgentKeys`，不发结构化 `userRevision`。
   因此结构化 diff 分支实际走不到，生效的是纯文本回落分支。要真正拿到"改后的字段"，
   需要前端提供结构化编辑表单。
2. **Coordinator 定稿时的 `taskBrief` 仍是旧契约**，且没有"此版本已被用户否决"的标记。
   若被指定 Agent 的意见含糊，Coordinator 存在漂回旧方案的风险。

## 7. 恢复方式

实现代码已回退。备份保留在 `/tmp/user-revision-backup/`：

- `format-brief-user-revision.ts`、`format-brief-user-revision.spec.ts`（两个新文件原件）
- `four-files-full.patch`（含改动的四个文件完整 patch）

注意该备份位于系统临时目录，重启后可能被清理；如需长期保留应移入仓库或其他持久位置。
