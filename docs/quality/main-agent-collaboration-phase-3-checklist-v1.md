# 阶段 3：主 Agent 主持讨论与可恢复专家协作 — Checklist v1

> 日期：2026-09-16
> 状态：实施完成，待用户验收（2026-09-19）。证据见第 1 节矩阵与第 5 节；新路径由 `MAIN_AGENT_DISCUSSION_ENABLED` 闸控。
> 依赖：阶段 1、2A、2B、2C 通过；核心正确性不依赖缓存命中。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-3-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-3-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-3-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-3-checklist-v1.md)

## 1. 验收矩阵

| 验收 ID | 关联任务 | 场景与预期 | 状态/证据 |
| --- | --- | --- | --- |
| P3-AC1 | P3-T1、P3-T2、P3-T5、P3-T6 | 简单补充可主 Agent 处理；涉及前后端约束时按需邀请相关已选专家，最终都有主 Agent 综合结论。 | **通过（单测 + E2E，mock runtime）**。主 Agent 出 `discussion_plan` 只点名需要的专家（`planned-discussion.spec` 用例 1：参与者 test 未被点名即不咨询）；每轮以 `synthesizeDiscussion` 收口，综合事件 `sourceDelegationIds` 可核验（用例 8；E2E 场景 A 恰 1 条）。"简单补充可主 Agent 处理"由 planner 支持零咨询 + `readyToSummarize`/`questionsForUser`（`discussion-planner.spec` 用例 7），未做端到端。 |
| P3-AC2 | P3-T4、P3-T5、P3-T6 | 讨论进行中用户 @ 质量 Agent 补充验收，形成独立可追踪委派并进入本轮/下一有效轮次汇总。 | **通过（单测）**。用户 @ → 每个被 @ 成员一条 `origin:'user_mention'` 委派，objective=用户原话，回复事件带 `delegationId` 并进入本轮综合（用例 6：run 复用、`roundsStarted`+1、无固定"已汇总"文案）。**未做**：@ 的 E2E 与双端展示。 |
| P3-AC3 | P3-T2、P3-T6 | 模型请求陌生 Agent 或禁用 Agent 时产生主 Agent 的成员选择请求，未确认前不调用。 | **通过（单测 + E2E）**。目录内非成员 → `confirm_member_addition` 卡，未批准零委派（用例 1；E2E 场景 B）；名字不存在 → `unknownTargets` 报出不编造（`discussion-planner.spec` 用例 3）；模型无法通过多余字段自行加人（`discussion-plan-output.spec` 用例 5）。**未做**：禁用 Agent 的专门用例（`participatingAgents` 过滤 `status==='active'`，禁用者只会落到扩员/未知两条路径之一，未单独断言）；扩员卡 approve/decline 的落实。 |
| P3-AC4 | P3-T1、P3-T3、P3-T6 | 提交后崩溃、完成事件重复、结果乱序时，同一委派最多一次有效完成，账单按实际尝试记录。 | **通过（file + PostgreSQL）**。同键（discussion|expert|revision）并发 12 个恰一个 reserved（store 用例 2）；跨实例只留一条委派（PG 集成 12/12）；完成重放 `idempotent`、终态不可回退（store 用例 6）；重启只跑未完成、不重问计划、不开第二个 run（用例 4）。账单：委派经 `runRuntime` 走 2A `budgetCategoryFor('discussion')='consultation'` 预留结算，按实际尝试记。**延后**：跨实例并发写同一 run 的 CAS（T1-3 已记）。 |
| P3-AC5 | P3-T2、P3-T5、P3-T6 | 两个专家意见相反时，主 Agent 明确分歧和选项；必需专家失败不以完整方案结束。 | **通过（单测）**。同 objective 不同结论 → `conflicts` 列出两条待选、outcome `needs_user`、正文不含"一致同意"（`discussion-synthesis.spec` 用例 2）；专家失败点名列出且 run 进 `waiting_user`、主 Agent 发一张 `discussion_clarification` 卡（用例 9），不以完整方案结束。 |
| P3-AC6 | P3-T1、P3-T2、P3-T3、P3-T6 | 专家超时、拒绝、缺证、主 Agent 失败分别有固定状态与恢复点；停止后所有派生咨询停稳。 | **部分通过**。超时/失败 → 委派 `failed{code,retryable}`（用例 2 用 RUNTIME_INVOCATION_ERROR、用例 9 用 RUNTIME_TIMEOUT）；主 Agent 出计划失败 → 抛 runtimeError 交既有 `retry_failed_execution` 恢复、不咨询不落 run（用例 10）；停止 → run `paused`、委派保持 `running` 可续（用例 5）；恢复点 = 持久化 run + `findResumable`。**未做**："拒绝/缺证"未映射到合同里已定义的 `blocked` 状态（专家 CONTEXT_INSUFFICIENT 目前落为 failed），`blocked` 尚无写入方。 |
| P3-AC7 | P3-T1、P3-T4、P3-T5、P3-T6 | 专家执行期间修订需求，旧版本结果只留历史；刷新任一端不会将过期建议当新结论。 | **通过（服务端）**。需求修订 → `reviseRequirement`：旧修订未完成委派 `superseded`、已完成保留但 `stale:true`（store 用例 7），综合只读当前 revision 非 stale（synthesis 用例 3），同一 run 重规划（用例 7）。**未做**：双端刷新的验证（未改前端；事件带 requirementRevision 供前端判旧）。 |

## 2. 现有验证入口

以下命令从仓库根目录运行，是后续实施回归入口，本次文档交付未执行这些业务测试。运行 E2E 前检查脚本使用隔离环境/mock，不能默认连接当前业务服务或真实模型。

```powershell
npm run test:e2e:multi-agent-discussion
node node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json --test apps/server/src/modules/orchestrator/orchestrator.service.spec.ts apps/server/src/modules/orchestrator/bounded-consultation.spec.ts
npm run test -w @project/web
npm run test:desktop
npm run test:e2e:planned-discussion   # 2026-09-19 新增：主 Agent 规划讨论（mock runtime，真服务，开关开启）
```

相关既有测试：

- [orchestrator.service.spec.ts](../../apps/server/src/modules/orchestrator/orchestrator.service.spec.ts)
- [SessionWorkspace.spec.ts](../../apps/web/src/components/SessionWorkspace.spec.ts)

## 3. 必须补充的测试

- [x] 持久化主 Agent 讨论/委派恢复测试（2026-09-19：`discussion-store.spec` 14 例、PG 集成 1 例、`planned-discussion.spec` 用例 4/5）。
- [ ] 用户中途 @ 与成员外邀请双端 E2E（待新增；不能用现有冒烟脚本代替）。
  进度：成员外邀请的**服务端** E2E 已有（`planned-discussion-smoke` 场景 B）；@ 的 E2E 与双端展示未做。
- [x] 专家分歧及必需咨询失败不得假成功测试（2026-09-19：`discussion-synthesis.spec` 用例 2/4/6、`planned-discussion.spec` 用例 2/9）。

## 4. 跨阶段安全复核

- [x] file/PostgreSQL 行为对等；涉及并发的场景用独立 PostgreSQL 和独立连接/实例验证，不只使用 mock。
  （2026-09-19：store 用例在 file 后端；PG 临时库 12/12 含跨实例并发 reserve）
- [x] 重复、乱序、重启、取消/删除、迟到结果均不破坏幂等与版本边界。
  （重放 idempotent、终态拒回退、旧 generation 拒开、旧 revision 拒 ask、删除后准入关闭拒写、abort 保留 reservation）
- [x] 未确认范围、高风险动作、未知停止状态均不会被摘要/缓存/模型判断绕过。
  （模型提议不落状态：成员由用户确认、schema 拒多余字段；讨论阶段仍只读，未新增写副作用）
- [ ] 双端保持同一业务状态和各自样式；不依赖刷新才能修复状态。
  本阶段未改前端：新增事件复用既有 `agent_message` / `user_confirmation_requested` 类型与 metadata，两端按既有样式渲染，专用呈现未做。
- [x] 无凭据、完整敏感提示或用户私有正文进入测试报告与指标。
  （`ExpertReport` 封闭形状拒绝思考过程；事件只带结论与 id；未新增 metrics）
- [x] 所有文档/合同更新与实际实现一致，回退方案已演练或明确未执行。
  文档已同步；回退 = 取消 `MAIN_AGENT_DISCUSSION_ENABLED`（默认即关），旧循环逐字未动，**未演练**。

## 5. 证据记录

每个结果记录：日期、构建/工作树版本、执行环境、fixture、命令、退出码、观察结果和证据路径；未执行/跳过必须写原因，不能记作通过。真实模型验证与 stub 验证分开记录。

阶段通过条件：用户 @、按需咨询、主 Agent 实质汇总、统一澄清、成员授权、版本与重启恢复全部通过，讨论无源码写副作用。

本次初始状态：所有业务验收待验证；只完成 SDD 文档编制，不代表功能已经开发或上线。

### 2026-09-19 实施记录（stub 验证，未调用真实模型）

- 工作树：`main` @ `d6b162f` + T6 改动。环境：Windows 11，Node v20.19.6，PostgreSQL 容器 `agent-cluster-postgres`。
- 定向：`discussion-contracts.spec` 8/8、`discussion-plan-output.spec` 5/5、`discussion-store.spec` 14/14、
  `discussion-planner.spec` 8/8、`discussion-synthesis.spec` 6/6、`planned-discussion.spec` 10/10、
  `orchestrator.service.spec` 69/69（旧路径逐字未动）；PG 集成 12/12（`RELATIONAL_TEST_DATABASE_URL`
  指向一次性临时库；直接指向共享开发库时前 8 条会因开发数据的内容引用报 `CONTENT_UNAVAILABLE`，属环境非回归）。
- E2E：`npm run test:e2e:planned-discussion` exit 0（两台隔离 smoke 服务，mock runtime）。
- 全仓：`npm run typecheck` / `test` / `test:harness` / `build` 全部 exit 0（见各提交记录）。
- 踩坑：spec 之间互相 `import` 会让 node:test 把整套用例重复注册（夹具已抽到 `orchestrator.test-fixtures.ts`）；
  `Object.groupBy` 不在本仓库 TS lib 目标内；冲突判定最初按"结论文本不同"误判了不同问题的正常差异，改为
  同 objective 内比较。
- **阶段结论：实施完成，待用户验收。** 阶段退出条件（用户 @、按需咨询、主 Agent 实质汇总、统一澄清、
  成员授权、版本与重启恢复、讨论无源码写副作用）均有服务端证据。**需用户决定的缺口**：(1) 双端专用呈现未做
  （复用既有事件类型渲染）；(2) 扩员卡与澄清卡的选项处理未接（approve 后加人并补委派 / proceed_anyway）；
  (3) `blocked` 委派状态无写入方；(4) 开关默认关，是否在验收时置为默认开。
