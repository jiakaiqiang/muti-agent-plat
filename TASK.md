# TASK.md — Session Runtime 动态切换（SDD 实施）

状态：阶段 A（T01–T12）已完成（2026-09-26 开工；T07–T09 于 2026-10-13 核对后补勾）。阶段 B/C 未按本清单验收；
`runtime-switch-coordinator.ts`（2026-10-11）已开始接 B 阶段，但 Checklist SRS-AC 仍为「待执行」，不声明 Runtime 已可切换。

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

- [x] T07 纯状态迁移表 + 非法迁移测试（AC8、AC9）
      `requested → preflighted → stopping → stop_confirmed → applying → resuming → completed`
      任意阶段可 `→ failed` 并记 failureStage；终态不可回退
      2026-10-13 核对补勾：迁移表在 shared `runtime-switch-contracts.ts`（`canTransitionRuntimeSwitch` 等），
      随 T04 一并落地，13/13 绿。**落点偏离**：SDD 写的 server `runtime-switch-state.ts` 未建，
      store 与 coordinator 直接用 shared 表，避免两份迁移表。
- [x] T08 file collection：创建、查询、幂等键、CAS（AC8）
      2026-10-13 核对补勾：`runtime-switch-store.ts` open/transition/list/get/current/unresolved；
      幂等键冲突、同会话单飞、版本单调 +1、非法迁移不改记录、删除/恢复代次拒绝、重启保留。
      `runtime-switch-store.spec.ts` 跑真实 file 后端 11/11 绿。
- [x] T09 relational 映射 + migration 单元测试（AC9、AC12）
      迁移号按仓库最新实际编号追加，不预占
      2026-10-13 核对补勾：V18 `runtime_switch_requests`（logical_key unique、单活跃部分索引、version>0 等）+
      schema spec 断言；store 的 loader/writer/集合登记/写入顺序已接。集成 spec 在一次性空库上 20/20 绿
      （含跨实例 open/transition 往返）。**遗留小缺口**：`writeRuntimeSwitchRequests` 无单元测试，
      只靠集成 spec 覆盖，而集成 spec 无 `RELATIONAL_TEST_DATABASE_URL` 时会 skip。
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

---

# TASK.md — 删除会话慢：relational 集合增量写（渐进式）

状态：2026-10-13 阶段 1 完成且用户已验收（删除正常）。阶段 2a、桌面删除交互修正、阶段 2b 均已完成，待用户验收。

根因（已核实）：`relational-state-store.ts` `mutateCollections` 把有变化的整个集合交给
`write*`；`writeEvents` 对所有会话全部事件逐行 upsert（每条 2 次 SQL），`writeEventOutbox`
再逐行写全部 outbox。一次删除走 3 次此类事务。见 memory `session-delete-slow-full-collection-rewrite`。

## 阶段 1：eventsBySession / eventOutbox 增量写

- [x] S0 备份开发库（pg_dump）+ 建隔离基准库 `agent_cluster_bench`（从主库克隆，不碰主库）
      备份 `.cache/db-backup/agent_cluster-20261013-181402.dump`（3.4M）；重建基准库 `bash .cache/db-backup/reset-bench.sh`
- [x] S1 基准脚本：在基准库上测一次生命周期事务的 SQL 次数 / 耗时（改动前基线）
      `npm run test:perf:session-delete-write`（需 BENCH_DATABASE_URL，库名非 *_bench 拒跑）
      基线：stopRequest 8116 次/7.7s、beginDelete 8137/7.8s、completeDelete 8136/8.0s，合计 24389 次 / 23.5s
- [x] S2 `writeEvents` 新事件序号改为库内 `max(session_seq)+1`（去掉按数组下标编号，增量写的前提）
      已有行冲突时保持原序号（on conflict 不改 session_seq）；replaceState 全量写在空表上仍得到 1..n。
- [x] S3 `mutateCollections` 对 eventsBySession / eventOutbox 只写新增或变化的记录
      `changedRecordsOnly` 只对这两个 upsert-only 集合生效，其余集合仍整写；返回给调用方的 state 仍是完整集合。
- [x] S4 单元测试：未变事件不重写、新事件序号接续、outbox 不重复、其他会话不受影响
      `relational-state-store.spec.ts` +3 条，先红（3 fail）后绿，文件 14/14。
- [x] S5 改动后基准对比 + typecheck + 相关 spec + 重启后端冒烟
      基准：24389 次 / 23.5s → 119 次 / 1.1s；duplicateSeq=0、eventsWithoutOutbox=0；新事件 seq 141–143 接续。
      typecheck 绿；server 全量 1881/1882，唯一失败 `generic-llm-tool-loop-budget.spec.ts` 回退本改动后仍失败（既有未提交改动所致，与本任务无关）。
      后端已 `dev:restart-server`，health ok、写入错误日志 0 条。

## 阶段 1 之后的耗时拆解（2026-10-13 实测，基准库）

每次事务约 330ms：整集合加载 events+outbox 两条查询约 140ms；进程内 clone + JSON 比较约 165ms；
会话/生命周期/停止请求写入约 30ms。**原定阶段 2（sessions 等增量写）对删除只省约 10%**。
剩余成本随**全部会话的事件总量**线性增长，数据涨 10 倍删除会回到约 10s。

## 阶段 2a：事件 / outbox 按会话范围加载（用户 2026-10-13 选定，先做）

- [x] A1 失败用例：范围加载只读本会话事件与 outbox；越界写入被拒；提交后内存里其他会话的事件/outbox 不被清掉
      relational spec +2、persistence-scoped-mutation spec +2（含 file 后端越界），先 4 红后全绿。
- [x] A2 `mutateCollections(keys, mutator, { sessionIds })`：relational 加载按会话过滤；relational 与 file 两种后端都做越界守卫
      新模块 `persistence/collection-scope.ts`（守卫 + 合并 + changedById，阶段 1 的 helper 移入复用）。
- [x] A3 PersistenceService 提交后按会话合并内存缓存（不再整集合替换这两个 key）
      基准库实测：删除后内存缓存与库内全量重读逐条一致；其余 9 个会话 2504 条事件一条未少。
- [x] A4 接线：SessionLifecycleStore 8 个方法 + SessionStopStateStore.requestWithEvent 传本会话范围
- [x] A5 验证：基准对比 + 相关 spec + typecheck + 全量 + 重启冒烟
      基准 1000ms → 182ms（events/outbox 加载 140ms → 约 10ms）；相关 spec 278/278；typecheck 绿；
      全量 1885/1886（唯一失败仍是既有的 tool-loop-budget）；后端重启 health ok，写入/越界错误 0。

## 插入：桌面端删除交互修正（用户 2026-10-13 验收 2a 时提出，先于 2b 处理）

- [x] U1 删除当前会话后：选中列表里它下面的会话；没有就选上面的；列表空了显示空工作台（标题、描述为空，不再显示被删会话内容）
      新模块 `workspace/sessionListModel.ts`：侧栏分组顺序与删除后选择共用一份逻辑。根因：原逻辑取 `sessions[0]` 不排除墓碑，且无会话时不清 currentSession。
- [x] U2 去掉「已删除」tab；已删除的会话在任何列表都不显示，也没有恢复入口（只保留归档的恢复）
- [x] U3 先写失败用例（列表顺序/相邻选择模型 + Sidebar），再实现；跑 desktop 相关 vitest + typecheck + 构建
      先红后绿；desktop 组件 vitest 43/43；renderer vue-tsc 0 错；desktop build 绿；Electron 渲染冒烟 pass（截图确认无「已删除」tab、空标题）。

范围：只改桌面端 `apps/desktop/renderer`。Web 端 SessionSidebar 也有同样的「已删除」tab，本次未动。

## 阶段 2b：会话相关集合增量写（2026-10-13 开工）

- [x] B0 基准加一步「普通会话保存」（touchSession 路径）测改动前基线
      基线：saveOneSession 114 次 / 133ms（10 个会话全量重写）；删除三步每步 14 条生命周期全量写。
- [x] B1 失败用例：改 1 个会话只写这 1 行、其余会话不被软删；从集合移除的会话只软删它自己；
      生命周期/停止请求/logical operations 只写变化的会话；整集合写入口（replaceState）仍保留软删语义
      relational spec +4（3 红 1 绿回归），实现后 26/26。
- [x] B2 `sessions`：拆出单会话写入，增量时 upsert 变化的 + 显式软删被移除的 id（不再走 softDeleteMissing）
      `writeSession` / `writeSessionChanges`；`writeSessions` 保留给整集合入口（replaceState、mutateStateAtomically）。
- [x] B3 sessionLifecyclesBySession / sessionStopRequestsBySession / logicalOperationsBySession 纳入 `changedRecordsOnly`
- [x] B4 验证：基准 + 相关 spec + typecheck + 全量 + 重启冒烟
      基准：saveOneSession 114→19 次、133→28ms；删除三步 119→57 次；liveSessionsAfter=10（无误删）。
      基准库真实 setCollection：改 1 个只改它、移除 1 个只软删它，缓存与库内全量重读一致。
      typecheck 绿；全量 1889/1890（仍只有既有 tool-loop-budget）；重启 health ok、写入错误 0、开发库近 2h 无软删。

不做：`writeCollectionsAtomically`（mutateStateAtomically）仍整集合写，只在少量调用方使用，留待后续。

## 第三轮：补齐未做项（用户 2026-10-13 要求「没有做的需要实现」）

- [x] C1 归档当前会话后同样选相邻会话（下一个→上一个→空工作台），桌面 + Web
      两端 `openNeighbourAfterRemoval` 共用删除与归档；`disconnectSse()` 保留在调用点（既有 spec 锁定其在后端确认之后）。
- [x] C2 Web 端去掉「已删除」tab、已删除会话不显示；删除后选相邻会话；列表顺序模型移到 web `utils` 两端共用
      新 `apps/web/src/utils/sessionList.ts`（过滤 + 相邻选择）；桌面 `sessionListModel.ts` 只剩分组。Web 空工作台标题为空。
- [x] C3 event_outbox 按会话查询加索引（新迁移，编号接在仓库最新之后）
      V22 `event_outbox_session_lookup`（只建索引）；基准库实跑 explain 走索引；开发库已迁移到 22（迁移前备份 pre-v22 dump）。
- [x] C4 其余读写 eventsBySession 的调用方：逐个核实只碰单会话后接入会话范围加载
      接入：context-management `mutate`（原本就收 sessionId 未用）、logical-operation `mutateStopAware`、runtime-health flush（批内全部会话）、runtime-switch `apply`。
      **有意保留整加载**：`confirmTransportReceipt`——会话只能在锁内快照里由 invocationId 反查，预先定范围会因缓存过期误拒停止回执。
- [x] C5 `mutateStateAtomically` → `writeCollectionsAtomically` 也只写变化的记录（sessions 显式软删）
      抽出共用 `writeChangedRecords`；新用例在旧实现上红、新实现上绿。现在只有 replaceState 走整集合 softDeleteMissing。
- [x] C6 验证：server 全量 + web/desktop vitest + 两端 typecheck + 构建 + 基准 + 重启冒烟
      server 1892/1893（仍只有既有 tool-loop-budget）；web+desktop vitest 436/436；server typecheck、web 与 desktop renderer vue-tsc 均 0 错；
      desktop / web 构建绿；基准 76 次 / 154ms、liveSessionsAfter=10；重启后迁移到 22、10 个在库会话、写入错误 0。

不在本轮：T07–T09（Runtime 切换阶段 A）、`generic-llm-tool-loop-budget.spec.ts` 既有失败——收尾时向用户确认。

