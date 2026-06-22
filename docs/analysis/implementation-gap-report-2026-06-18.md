# Agent Cluster 实现状态与问题分析报告

> 生成时间：2026-06-18
> 分析范围：当前工作树（含未提交改动）
> 验证方式：实际运行项目自带质量门 + 逐文件读源码，不依赖状态文档自述
> 分支：main（提交 5a0f338）

## 1. 结论速览

PRD（`docs/product/agent-cluster-prd-v1.md`）覆盖完整、文档纪律性高。但当前代码真实状态落后于文档与根目录几份“修复完成”报告所宣称的程度。

核心判断：**文档和自述报告跑在了已验证代码状态的前面。**

| 问题 | 严重度 | 验证方式 | 现状 |
| --- | --- | --- | --- |
| 核心黄金链路 e2e 失败，卡在 `WAIT_USER_DECISION` | P0 | 运行 main-chain / p1-behaviors | 红 |
| `WAIT_USER_DECISION` 死锁（状态机设计缺陷） | P0 | 读源码定位调用链 | 存量缺陷 |
| Harness 一致性测试失败 | P1 | 运行 test:harness | 红（69/71） |
| 状态文档对 Runtime 既高估又低估 | P1 | 逐个读 adapter | 文档失准 |
| 根目录 AI 报告自夸 + 工作树脏 | P2 | git status | 35 文件未提交 |

> 注：飞书 connector 当前为草稿生成器、未接真实 API。经确认本轮不实现，列入后续计划（见第 8 节），不作为当前待修问题。

## 2. 已通过的部分

- `npm run typecheck`：通过（shared + server，web 无 typecheck 脚本）。
- 服务器可正常启动监听（`server-8089.err.log` 为历史日志，非当前状态）。
- Codex / Claude Code adapter 实为完整真实 CLI 实现（见 4.3）。
- Generic LLM Runtime 为真实 OpenAI 兼容 HTTP 调用，默认 mock fallback 关闭。

## 3. P0：核心黄金链路 e2e 失败

### 3.1 现象

```
npm run test:e2e:main-chain    -> Error: Timed out waiting for status COMPLETED, last=WAIT_USER_DECISION
npm run test:e2e:p1-behaviors  -> 同样报错
```

对应 PRD 第 18 节核心场景：执行中用户插话加约束 → 系统路由 → 执行恢复并跑到完成。实际恢复不了，死在 `WAIT_USER_DECISION`。

### 3.2 完整调用链（已逐行定位）

1. 用户插话走 `apps/server/src/modules/sessions/sessions.service.ts:247` 的 `shouldPause` 分支，调用 `restartExecutionWithUpdatedContext`（line 848）。
2. 该函数把任务过滤为 `unfinished.filter(id !== interruptTaskId)`（line 865），`execution.cancel` 后重启 pipeline（line 885）。
3. 重启后 pipeline 在 `apps/server/src/modules/orchestrator/orchestrator.service.ts:356-361` 重新计算就绪任务。若剩余任务的依赖在这一轮被判未就绪，直接返回：

   ```ts
   return { kind: 'ask_user', reason: messages.dependencyBlocked };
   ```

4. `ask_user` 经 `applyOutcome` 把状态设为 `WAIT_USER_DECISION`（`sessions.service.ts:415`）。
5. 撞上致命 guard `sessions.service.ts:406`：

   ```ts
   if (session.status === 'WAIT_USER_DECISION' && outcome.kind !== 'ask_user') {
     return;   // delivered 结果被静默丢弃，永远回不到 COMPLETED
   }
   ```

一旦进入 `WAIT_USER_DECISION`，后续任何 `delivered` 结果都被这行吞掉，会话再也到不了 `COMPLETED`。

### 3.3 根因定性

- `sessions.service.ts:406` 的死锁是**存量已提交代码的状态机设计缺陷**：它假设 `WAIT_USER_DECISION` 之后只可能来 `ask_user`，但插话重启后完全可能来 `delivered`。
- 未提交 diff 中 `sessions.service.ts` 只改了 23 行，且全是 engineering-runtime 配置归一化，未触及 bug 区域。
- `orchestrator.service.ts` 改了 347 行（净增），含 `@@ +1959,155 @@` 一个 155 行新增块及 token 区改动。把 e2e 从绿压成红的触发条件，极可能是这次未提交改动改变了任务依赖/就绪时序。
- 结论：**存量死锁缺陷 + 未提交改动改变就绪时序，两者叠加导致回归。**

## 4. 其余问题

### 4.1 P1：Harness 一致性测试失败

```
npm run test:harness -> Phase 3 FAILED (69/71)
FAIL prompt-context/runtime-context-contract.md (32/34)
  x ContextPack field 'runtimeSelection' covered
  x ContextPack field 'projectMap' covered
```

该文档自述“reality-synced”，实际未同步：代码新发出的两个 ContextPack 字段，合同文档未覆盖。问题虽小，但红的恰是 harness 存在的意义——抓文档与代码漂移。

### 4.2 P1：状态文档对 Runtime 既高估又低估

`docs/analysis/feature-inventory-and-status-v1.md` 与实际不符：

| Runtime | 文档说法 | 实际 |
| --- | --- | --- |
| Codex / Claude Code | “已注册但返回未实现” | **完整真实 CLI adapter**，`execFile` 调 `codex`/`claude`，抓文件 diff 与测试命令；仅被 `CODEX_RUNTIME_ENABLED` / `CLAUDE_CODE_ENABLED` 默认关闭 |
| MCP Tool / Human | 预留 | 准确：只有合同类型与标签，无 adapter，未注册，派发落到 “runtime not implemented” |
| 飞书 connector | 部分 | 仅草稿生成，未接真实 API；本轮不实现，列入后续计划（第 8 节） |

### 4.3 P2：根目录 AI 报告自夸 + 工作树脏

- `VERIFICATION_REPORT.md`、`FIX_COMPLETE.md`、`IMPLEMENTATION_SUMMARY.md` 为满屏 emoji 的 AI 生成报告，宣称“✅ 100% 修复、失败率 0%”，而此刻核心 e2e 为红。
- 工作树有 35 个改动/未跟踪文件未提交，含 `orchestrator.service.ts` 净增 347 行。
- 该报告“验证”的是“会话没有立刻失败”，而非“链路能跑完”——自信与测试结果之间存在明显落差。

## 5. 主线判断

文档与自夸报告跑在了已验证代码状态前面：状态文档对过时项标“完成”，“VERIFICATION_REPORT 通过”与两个失败的核心 e2e 并存，347 行 orchestrator 改动压在它很可能弄坏的流程上且未提交。项目自身的 CLAUDE.md 要求“说明验证了什么 / 测试不能跑时说明原因”，最近这轮交付未守住。

## 6. 建议（按杠杆排序）

1. **确认回归来源**：用 `git worktree add` 检出干净的 `5a0f338` 副本，跑 `npm run test:e2e:main-chain`。若绿，则坐实未提交 orchestrator 改动改了依赖/就绪时序。（不要 stash 当前工作，避免丢失在制品。）
2. **修死锁本身**：`sessions.service.ts:406` 的 guard 是设计缺陷，需允许 `delivered` 覆盖 `WAIT_USER_DECISION`，或让插话重启路径在仍有可交付任务时不落到 `ask_user`；配套审 `restartExecutionWithUpdatedContext`（line 865）对依赖任务的过滤。
3. **让 harness 门变诚实**：补 `runtime-context-contract.md` 的 `runtimeSelection` + `projectMap` 覆盖，否则“全绿”说法失效。
4. **状态文档对齐现实**：改 Codex/Claude 描述，停止把飞书称作 connector；删除或归档根目录三份 `*_COMPLETE/REPORT/SUMMARY.md`。

## 7. 验证记录

| 检查项 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过 |
| Harness 一致性 | `npm run test:harness` | 失败（Phase 3，69/71） |
| 主链路 e2e | `npm run test:e2e:main-chain` | 失败（卡 WAIT_USER_DECISION） |
| P1 行为 e2e | `npm run test:e2e:p1-behaviors` | 失败（同上） |
| Runtime adapter | 逐文件读源码 | 见第 4 节 |

> 本报告仅做诊断，未改动任何业务代码、未提交。

## 8. 后续计划（本轮不实现）

以下为 PRD 列出但当前为空或仅占位的能力，经确认本轮不修，留作后续迭代：

| 能力 | 现状 | 后续验收要点 |
| --- | --- | --- |
| 飞书 connector | 仅生成 `feishu_draft` 草稿 + 确认卡（`orchestrator.service.ts:986`），无真实 API 客户端；能力 `cap-feishu-draft` 自述“不直接对外发送” | 接 Feishu/Lark API，保留发送前确认、失败回滚与审计事件 |
| MCP Tool Runtime | 仅合同类型与标签，无 adapter、未注册 | 增加 MCP registry、能力绑定、工具审计与最小 e2e |
| Human Runtime | 仅合同类型与标签，未接等待用户输入流程 | 增加 human task 等待/响应 API、超时策略与恢复语义 |

说明：PRD 第 14 节将上述列为 Runtime Layer 项，但其缺失不影响当前 P0/P1 修复（核心链路死锁、Harness 红、文档失准）。建议先修 P0/P1，再按上表排期。
