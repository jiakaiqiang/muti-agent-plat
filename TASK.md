# TASK.md — Session Runtime 动态切换（SDD 实施）

状态：阶段 A（T01–T12）进行中，2026-09-26 开工。阶段 B/C 未开工。

依据四件套（2026-09-26 生成）：
`docs/product/session-runtime-switch-spec-v1.md`（SRS-AC1–AC12）、
`docs/design/session-runtime-switch-plan-v1.md`（设计与落点）、
`docs/implementation/session-runtime-switch-tasks-v1.md`（T01–T43）、
`docs/quality/session-runtime-switch-checklist-v1.md`（验收矩阵）。

本轮范围：**只做阶段 A（T01–T12）**，用户已确认。阶段 A 退出条件明确要求
「不声明 Runtime 已可切换」——合同、状态机、持久化结构可独立测试即达标。

## 已核实的代码事实（开工前读出，不是设计愿望）

- `RuntimePreference`（`packages/shared/src/contracts.ts:1488`）只有三个字段：
  `preferredRuntimeType` / `preferredModelId` / `allowedRuntimeTypes`。
  **没有** `fallbackRuntimeTypes`、**没有** `revision` —— T03 要补的就是这两个。
- `SystemAgentRuntimePolicy`（同文件 1524）是 `RuntimePreference & { role, updatedAt }`，
  所以给 RuntimePreference 加字段会**同时**影响系统 Agent 策略类型，T03 必须确认这是期望的。
- `ExecutionTerminationKind`（3250）九个值里**没有** `runtime_switch`；
  `user_paused`、`user_cancelled` 已存在且语义独立 —— T05 要新增而不是复用。
- `RuntimeAttemptTrace`（3110）有 `attemptGroupId` / `attempt` / `retryOfInvocationId` /
  `fallbackFromRuntimeType` / `fallbackReason`，**没有** `trigger` / `switchRequestId` /
  `switchFromRuntimeType` —— T05 要补这三个。
- `apps/server/src/modules/runtime-switch/` **不存在**，T07/T08 是从零建模块。
- `runtime_switch` 全仓零命中（业务代码），确认无既有实现可复用。
- 复用而非另建：`SessionLifecycleStore`（已有 generation fence）、stop-state、
  `ChangeRequestStore`（阶段 5 刚建，状态机 + 幂等 + generation 守卫的**范式参考**）、
  `InvocationResolverService`（已有 allowlist/Workspace/Capability/Tool 校验）。
- 工作区已有 13 个文件未提交改动（主 Agent 兜底派发 + 契约确认门禁 + 前端协作视图），
  与本 SDD 文件层面重叠但逻辑不冲突。T01/T02 要动的 spec 文件在其中，需增量追加不覆盖。

## 阶段 A 任务清单（做完才勾）

### 失败回归固化（T01–T02）

- [x] T01 固化 PAUSED 下「切换到 Claude Code 继续」被 queued 的失败回归（AC2）
      `sessions.service.spec.ts` 新增 1 条：断言的全是**坏行为**（deferred=true、
      status 停在 PAUSED、queued、preferredRuntimeType 仍是 codex、processNextFollowUp
      排不空队列）。注释写明 T29 修好时这条必须**重写为断言切换**，不许放宽或删除。
- [x] T02 固化用户 Abort 不触发 Provider fallback + 现有 retry/fallback 基线（AC7）
      `orchestrator.service.spec.ts` 新增 1 条，覆盖两种停止形状：
      ① `status:'cancelled'` 且同时带 retryable providerFailure → 只调 1 次、不换 Runtime；
      ② 执行中 abort signal → attempt 循环立即停，且全程无
      `RUNTIME_PROVIDER_FALLBACK` / `RUNTIME_PROVIDER_RETRY_SCHEDULED` 事件。
      读出的三道既有闸门（orchestrator.service.ts:7818/7819/7821）与 Spec §7.4 一致。

### 共享合同（T03–T06）

- [x] T03 RuntimePreference 增 `fallbackRuntimeTypes` / `revision` + 规范化校验（AC6、AC11）
      新建 `packages/shared/src/runtime-switch-contracts.ts`（browser-safe，已导出 index + 重建 dist）。
      `normalizeRuntimePreference` 6 条用例绿：去重保序、过滤非法值、**allowlist 外的
      preferred 被丢弃而非扩大 allowed**、fallback ⊆ allowed 且不含 preferred、
      revision 只收非负整数（0 是有效初版）、不改也不别名调用方输入。
      顺带修掉一处漂移源：`RuntimeType` 的运行时值列表原先只在服务端
      `runtime-config.ts` 有一份，已提为 shared `RUNTIME_TYPES` + `isRuntimeType`，
      服务端改为 re-export，避免 shared/server 两份清单各自演化。
      **一处断言方向纠正**：我最初断言「无 allowlist 时 fallback 顺序应被丢弃」，
      这是错的——顺序不授权，授权由解析期交集决定，丢顺序只静默吞用户意图。
      已改为保留顺序并注释说明 I5 的真实含义。
- [x] T04 RuntimeSwitchRequest / status / fallbackMode 合同（AC8、AC9）
      6 条用例绿。状态机把 I1 编码进迁移表：`applying` **只能**从 `stop_confirmed` 到达，
      `requested`/`preflighted`/`stopping` 都到不了；`stopping` 不能自环也不能回退
      （回退等于重开 admission）；终态 `completed`/`failed` 无出边。
      `preflighted → stop_confirmed` 这条边是给「无活动 Invocation」场景留的直通路径。
      `canRetryRuntimeSwitchFrom` 只拒 `resuming`（写任务无可信候选时等人，I8）。
      幂等键含 sessionId（同一客户端键跨 Session 不得并成一个请求）；
      事件键 `runtime-switch:<id>:<version>` 使重放成为 no-op。
- [x] T05 `runtime_switch` termination + attempt trace 三字段（AC4、AC7）
      shared 加 `runtime_switch` kind + `RuntimeAttemptTrigger`（initial/retry/fallback/
      manual_switch）+ `switchRequestId` / `switchFromRuntimeType`（与既有
      `fallbackFromRuntimeType` 分开，两者语义不同）。
      服务端三处接线：安全文案、`isExecutionTermination` 白名单、disposition。
      **disposition 归 `stop` 不是 `replace`**：`terminationRetryable` 由 disposition
      推导，归 `replace` 会让 retryable=true，等于允许 provider 重试链重启刚被切换
      屏障停掉的那次调用。2 条新用例锁死 retryable=false 且 source 记为 user。
- [x] T06 API / Event / Runtime 合同文档精确增量（AC12）
      三处按仓库既有「日期追加章节」约定写入，未改历史章节编号：
      `api-contract-v0.1.md` §Session Runtime 动态切换 API（POST/GET、Idempotency-Key、
      409 语义、灰度开关关闭时不退化为排队）；
      `event-contract-v0.1.md` §Runtime 切换事件（payload 字段白名单、
      `runtime-switch:<id>:<version>` 幂等键、旧客户端安全忽略）；
      `runtime-contract-v0.1.md` §Runtime 主动切换接管（`runtime_switch` disposition=stop、
      trigger 四值、禁跨 Runtime 传 cliSessionId、generation fence）。
      `npm run test:harness:v2-only-docs` 10/10 绿。

### 状态机与持久化（T07–T10）

- [ ] T07 纯状态迁移表 + 非法迁移测试（AC8、AC9）
      `requested → preflighted → stopping → stop_confirmed → applying → resuming → completed`
      任意阶段可 `→ failed` 并记 failureStage；终态不可回退
- [ ] T08 file collection：创建、查询、幂等键、CAS（AC8）
- [ ] T09 relational 映射 + migration 单元测试（AC9、AC12）
      迁移号按仓库最新实际编号追加，不预占
- [x] T10 PostgreSQL 原子更新与并发幂等集成夹具（AC8、AC12）
      `postgres-migration-runner.integration.spec.ts` 新增 1 条，按仓库约定建独立库
      （`agent_cluster_rs_<pid>_<ts>`）跑完 drop，不碰主库；无
      `RELATIONAL_TEST_DATABASE_URL` 时 skip。
      覆盖：同 Idempotency-Key 跨实例并发折叠成一行、不同键的第二个切换被
      `RUNTIME_SWITCH_ALREADY_IN_PROGRESS` 拒、走完屏障四步后
      `version=5`/`status=applying`/`lifecycle_generation=3` 均在**真实列值**上核对、
      `stop_confirmed → stopping` 回退跨实例也被拒（I1）。
      **两处自身断言纠错**（都是阶段 5 同款坑）：
      ① 并发下两个实例各自事务看不到对方，双方都返回 `opened` 是正常的，
         PG 主键折叠成一行；原先断言内存 `list().length === 1` 对快照重叠情形过强，
         已改为断言两边 id 相同 + SQL 只有一行。
      ② 拒绝码写成 `ALREADY_IN_FLIGHT`，实际是 `ALREADY_IN_PROGRESS`。
      实跑证据：Docker `agent-cluster-postgres` 容器上定向 1/1 绿；
      干净独立库全套 **19/19 绿**（含既有 18 条），确认 V18 无回归。
      注意：直接对主库 `agent_cluster` 跑会有 9 条失败，错误是
      `CONTENT_UNAVAILABLE: content object does not exist` ——
      该开发库已跑 4 天且本地内容存储被清理过，属**环境数据失效不是代码回归**，
      已在干净库上交叉验证。后续跑这批集成测试一律用独立库。

### 命令解析（T11–T12）

- [x] T11 Runtime 别名规范化 + 明确切换句式解析（AC1、AC2）
      新建 shared `runtime-alias.ts`：`runtimeDisplayName` / `resolveRuntimeAlias` /
      `matchRuntimeSwitchCommand`，别名表（含中文「克劳德」、CC 缩写等）只此一份。
      解析器接进既有 `DeterministicCommandGuardService.matchRuntimeSwitch`，
      不新建 `sessions/runtime-switch-command.ts`——**这是对 SDD 落点的有意偏离**：
      仓库已有确定性命令唯一归口（6 类匹配器），另建文件会造第二套别名表，
      正好违反 Spec §7.1「别名来自统一注册表」。前端显示名散落 5 处（web
      runtimeLabels.ts、web/desktop SessionWorkspace.vue、server runtime-config.ts）
      是既有技术债，本任务不动，留待前端 T33/T34 收敛到 shared。
- [x] T12 负/正样例：问句、比较、未知 Runtime、只使用、继续语义（AC1、AC2）
      与 T11 同一份 `runtime-alias.spec.ts` 11/11 绿，负样例覆盖：
      问句/比较（为什么、能不能、是否应该、should/can/why、区别）、
      纯需求（「给 Claude Code 的调用加重试日志」等只提及不切换）、
      否定（不要/别）、未知 Runtime（Cursor）、无 target、超长（>200 落语义路由）、
      既有控制命令（继续/暂停/恢复执行不被吸收）；正样例覆盖九种切换动词双语、
      复合「切换+继续」、「只用 X」→ target_only。
      守卫 spec 34/34 无回归；shared 全量 227/227。

## 纪律（沿用阶段 5 已验证的教训）

1. 先写失败用例，再实现。
2. 新 shared 模块：导出 `packages/shared/src/index.ts` + **重建 dist**，
   否则 server 解析旧 dist，只改 src 的修复会静默失效。
3. shared 不能 `import node:*`（被 web/desktop 消费，只跑 shared 门禁是假绿）。
4. server spec 必须在 `apps/server` 下跑 tsx（装饰器报错先查 cwd 不是查代码）。
5. PostgreSQL 不变量要查**列值**，不要拿内存态 JSON 的 id 当证据。
6. relational 接线是多处的：逐处 grep 核对 + 每处改完即 typecheck。
7. 跑全量 `npm run test` 时注意失败可能在**别的 spec 文件**里。
8. 阶段 A 不声明 Runtime 已可切换；不改 Checklist 的完成标记。

## 阶段 B/C（本轮不做，留给后续会话）

- T13–T32 服务端切换闭环：API、预检、停止屏障、原子应用、Context 接管、fallback、恢复、事件。
- T33–T43 前端与整体验收：切换 API/快照/SSE 收敛、三态展示、E2E、四门禁、Checklist 回填。
