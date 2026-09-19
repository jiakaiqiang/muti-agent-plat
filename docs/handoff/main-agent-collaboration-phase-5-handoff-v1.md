# 交接：主 Agent 协作专项 · 阶段 5（执行中补充、新需求与范围变更治理）

> 日期：2026-09-19　|　接手前请先读 `TASK.md`（锚点，逐任务证据在那里）
> 本文件是执行记录 + 剩余工作说明，给下一个 agent 直接续做用。

## 1. 当前位置

| 阶段 | 状态 |
| --- | --- |
| 0 / 1 / 2A / 2B / 2C / 3 | 已实现并验收 |
| 4 主 Agent 文档、精确确认与所选工作流交接 | **已验收**（2026-09-19，用户确认；记录在 roadmap §18） |
| 5 执行中补充、新需求与范围变更治理 | **进行中**：T1–T5 完成，T5-2 待提交，**T6 未开始** |
| 6 双端综合验收、成本评测与受控上线 | 未开始（须等阶段 5 验收） |

规则（用户定的，必须遵守）：**上一阶段验收完成后才能开始下一阶段**。阶段 5 的 T6 跑完并经用户验收后，才能动阶段 6。

四件套文档：
- spec（AC 定义）`docs/product/main-agent-collaboration-phase-5-spec-v1.md`
- plan（设计落点）`docs/design/main-agent-collaboration-phase-5-plan-v1.md`
- tasks `docs/implementation/main-agent-collaboration-phase-5-tasks-v1.md`
- checklist（验收矩阵，**T6 要填这里**）`docs/quality/main-agent-collaboration-phase-5-checklist-v1.md`

## 2. 已推送的提交（`main`，新→旧）

```
03b9864 feat(clients): dual-end change queue projection (phase 5 T5-1)
720dae1 feat(sessions): offer queued changes when a run ends (phase 5 T4-2)
6856fb2 feat(context): guard inherited artifacts on new requirements (phase 5 T4-1)
43f6141 feat(orchestrator): bind acceptance reuse to requirement versions (phase 5 T3-2)
489b5ba feat(sessions): stop and freeze writebacks before revising on a scope change (phase 5 T3-1)
91816c4 feat(sessions): raise analysed change requests for execution-time scope changes (phase 5 T2-3)
69e65f6 feat(sessions): route execution-time @ questions to bounded consultations (phase 5 T2-2)
da5a8a8 feat(sessions): answer execution progress questions from state (phase 5 T2-1)
0de3b98 feat(sessions): durable change requests for execution-time scope changes (phase 5 T1)
203c5e4 docs(phase4): record the acceptance and carry the gaps into phase 5
```

T5-2 的改动（`change-request-store.ts` + 其 spec + `TASK.md`）**尚未提交**，工作树里是干净可提交状态，门禁正在重跑。

## 3. 阶段 5 已建立的东西（接手时可直接复用）

### 新增 shared 合同 / 投影（全部 browser-safe，已导出 `index.ts` 并重建 dist）
| 文件 | 作用 |
| --- | --- |
| `packages/shared/src/change-request-contracts.ts` | ChangeRequest 聚合：逻辑键（含需求/文档修订）、状态迁移表、分析时效判定、多意图消息拆段 |
| `packages/shared/src/execution-progress-projection.ts` | 执行进度确定性投影（回答「做到哪一步了」用，措辞取固定词表） |
| `packages/shared/src/result-reuse-contracts.ts` | 复用已完成结果的版本匹配证据；迟到旧结果识别 |
| `packages/shared/src/change-queue-projection.ts` | 变更队列双端共享投影（顺序、过期、`grantsExecution:false`） |

### 新增服务端落点
| 位置 | 作用 |
| --- | --- |
| `apps/server/src/modules/sessions/change-request-store.ts` | ChangeRequest 唯一真相（file + PostgreSQL），admission/generation fencing |
| `deterministic-command-guard.service.ts` | 三个新匹配器：`matchExecutionStatusQuestion` / `matchExecutionConsultationQuestion` / `matchExecutionScopeChange` |
| `sessions.service.ts` | `sendMessage` 三条短路 + `handleExecutionStatusQuestion` / `handleExecutionConsultation` / `handleExecutionScopeChange` / `resolveExecutionScopeChange` / `offerNextRequirement` |
| `orchestrator.service.ts` | `consultDuringExecution`（执行期 @ → 复用阶段 3 `runMentionDelegations`）；`requirementVersionBinding` |
| `task-acceptance-preflight.ts` | `acceptanceFingerprint` 新增第 4 参 `requirementVersion`，需求改版即失效旧验收 |
| `context-management.service.ts` | `assertInheritedArtifacts`（产物继承必须是本会话真实产物） |
| `sessions.controller.ts` | `POST /sessions/:sessionId/execution-scope-change` |

### PostgreSQL V16
新集合 `changeRequestsBySession` → 表 `agent_cluster.change_requests`。**八处接线**都在 `relational-state-store.ts`（+ migration runner + cutover CLI）：
`SESSION_KEYED_COLLECTIONS`、`KNOWN_COLLECTIONS`、`CHANGE_REQUESTS_SELECT_SQL`、load switch case、writer dispatch、`writeChangeRequests`、`loadStateWithClient` 的 readAll 行、`collectionWriteOrder` 数组；另加 `postgres-migration-runner.ts` 注册 `RELATIONAL_SCHEMA_V16_SQL`、`cutover-context-v2.cli.ts` seed。

### 双端投影（各自样式，业务状态共享）
- web `apps/web/src/components/changeQueuePresentation.ts` → 单条内联列表
- desktop `apps/desktop/renderer/components/workspace/changeQueuePresentation.ts` → 分组小节

## 4. 剩余工作

### 立刻要做：提交 T5-2
门禁（`bwx36rjoq` 后台任务）跑完且四项全 `exit=0` 后：
```bash
git add -A TASK.md apps/server/src/modules/sessions/change-request-store.ts \
  apps/server/src/modules/sessions/change-request-store.spec.ts
git commit -m "feat(sessions): fence change request mutations after delete and restore (phase 5 T5-2)"
git push
git status -sb   # 无 [ahead N] 才算推送成功
```

### T6-1 验证执行中交互矩阵（AC1–AC7）
`docs/quality/...-phase-5-checklist-v1.md` §3 要求的两项必须新增测试：
- [ ] ChangeRequest 版本/选择/队列并发测试
- [ ] 执行中 @、暂停修订和新需求排队双端 E2E

矩阵要覆盖：多意图消息、双端重复提交、影响分析过期、迟到旧结果、所选流程不支持检查点恢复、同会话串行 / 跨会话并行。

### T6-2 独立 PostgreSQL + E2E + 四门禁
参照阶段 4 T6 的做法：新写一个 `tests/e2e/*-smoke.mjs`，在 `package.json` 注册 `test:e2e:*` 脚本，用 `tests/e2e/smoke-server.mjs` 的辅助函数。

### 验收后
1. 把 checklist 七行 `待验证` 改成带证据的结论（**未覆盖**的部分要显式写出来，不要含糊）。
2. tasks 文档勾选 6 个任务框。
3. roadmap：§4 表格第 5 行标「已完成并通过验收」、顶部状态行、AC/任务计数、追加 §19 验收段。
4. 四件套状态行改为已验收。
5. 遗留缺口挂到阶段 6 的 tasks 文档。
6. **向用户确认验收**后才能开阶段 6。

## 5. 纪律（每个任务都照做，做完才勾）

1. **先写失败用例，再实现。**
2. 新 shared 模块：必须 `export * from './x.js'` 进 `packages/shared/src/index.ts` **并重建 dist**（`npm run build -w @agent-cluster/shared`），否则 server 解析到旧 dist，修复静默失效。
3. server spec 必须在 `apps/server` 目录下用 tsx 跑（装饰器）：
   ```bash
   cd apps/server && node ../../node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.json --test src/modules/<path>.spec.ts
   ```
   装饰器报错先查 cwd，不要查代码。
4. **跑单个 spec 绿 ≠ 没回归。** 必须跑全量 `npm run test`；失败常在别的 spec 文件里。
5. 四门禁 + 隔离 PostgreSQL 全绿后才提交：
   ```bash
   npm run typecheck && npm run test && npm run test:harness && npm run build
   ```
6. 推送后用 `git status -sb` 的 ahead 标记核对，**不要只信 `git ls-remote`**（本环境 GitHub 连接频繁超时，push 常已成功而 verify 失败）。
7. shared 不能 `import node:*`（被 web/desktop 消费）；只跑 shared 门禁是假绿。

### 隔离 PostgreSQL 怎么跑
Docker 里 `agent-cluster-postgres` 常驻。建临时库再跑：
```bash
export PGPASSWORD=agent_cluster_dev
docker exec agent-cluster-postgres psql -U postgres -c "create database agent_cluster_tmp_$$"
RELATIONAL_TEST_DATABASE_URL="postgres://postgres:agent_cluster_dev@127.0.0.1:5432/agent_cluster_tmp_$$" \
  node ../../node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.json --test \
  src/modules/persistence/relational/postgres-migration-runner.integration.spec.ts
docker exec agent-cluster-postgres psql -U postgres -c "drop database if exists agent_cluster_tmp_$$"
```
当前基线：**15/15**（含 V16 用例）。

## 6. 本次踩过的坑（别再踩）

| 坑 | 教训 |
| --- | --- |
| V15 六处接线出过三处错（阶段 4） | V16 改为**逐处 grep 核对 + 每处改完即 typecheck**，八处一次到位 |
| PG 两行被我误判「跨实例去重失效」 | PG 里始终只有 1 行（主键 + `logical_key` 唯一约束）。**查列值，不要拿内存态 JSON 的 id 当证据** |
| `analysis_revision` 断言 `1 !== '1'` | bigint 被 node-pg 返回为字符串，断言要 `Number(...)` |
| 校验查询 select 了不存在的 `choice` 列 | 表列叫 `user_choice`；writer 与断言都要对齐 DDL |
| heredoc 把 `\n` 写成真实换行，破坏中文字符串 | 多行/中文补丁改用 Write 工具或 python 脚本文件，不要用 heredoc |
| `control(session,'COMPLETED')` 被 `assertControlTransition` 拒 | 生产是执行完成路径经 `setStatus` 到达终态，`EXECUTING→COMPLETED` 不是合法控制边；测试要按生产路径驱动 |
| T5-2 fencing 一度打断 T3-1 的停稳修订 | `pause()` 会 `closeForStop()` 主动关 admission。**新增请求**才 fence admission；**推进已有请求**只 fence 删除状态 + generation（`mutationRefusal` vs `admissionRefusal`） |
| 既有用例 14 因新守卫回归 | 根因是它夹具依赖旧的「产物零校验」行为（产物只作内存数组传入、从未落库）。守卫按 AC5 保留，改夹具 |
| 我的 E2E 断言一度比契约更强 | 重复确认在实现里是**幂等返回**（AC3 的「只提交一次」= 不产生第二个运行），不是第二次点击报错。断言要贴契约 |

## 7. 阶段 5 期间发现并修掉的真缺陷（不是测试问题）

1. **合法确认被判 stale**（阶段 4 T6 E2E 抓到）：`assertConfirmationCurrent` 原先用活动 WorkItem 计数器当需求版本判据，而 `WAIT_USER_CONFIRM` 状态流转本身会 +1 → 每次正常确认都被拒。改为以**文档自身记录的 `workItemRevision`** 为准。
2. **两节点以上工作流无法发布**：共享辅助 `createPublishedAgentWorkflow` 只设 `outputContract`，下游节点缺 `inputContract`（`workflow-managed-execution-smoke.mjs` 同样受影响）。
3. **需求改版后旧验收被复用**：`acceptanceFingerprint` 不含需求/文档版本 → 新需求会被旧 checkpoint 背书。
4. **产物继承零校验**：决定早有 `assertInheritedDecisions`，产物 id 直接照抄，跨会话 id 或拼写错误都能被记为「继承证据」。
5. **删除后迟到回调仍写入**：`recordAnalysis` / `recordChoice` / `transition` 原先无 fencing。

## 8. 跨阶段遗留（不属于阶段 5，别顺手做）

- 中断会话续接 G3：`npm run dev:restart-server` + 真实场景手测（人工项）。
- 跨实例 CAS（讨论/预算 run 并发写守卫），阶段 3 T1-3 起延后。
- 成本评测（冷/热缓存对比、priceVersion 来源）归阶段 6。
- 阶段 4 带入：真实浏览器渲染快照、进程级崩溃注入、流程「已下架」时序竞争、`blocked` 委派状态无写入方。
