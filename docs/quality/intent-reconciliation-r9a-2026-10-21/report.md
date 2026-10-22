# M-007 / R9a：人工对账服务端交付报告

日期：2026-10-21。依据：[R9 设计](../intent-reconciliation-r9-design-2026-10-21.md)、监督收件箱 M-007 与「第九轮设计复核」。基线为本地 `5ded5262d39b20a0d4c2dfe3cd8a5457faa1b4c2`；本轮未提交、未推送。

已实现新链路的案件、事实查询、三种结构化决定、独立 attempt 和持久化派发／结果栅栏。最终 18 文件 spec 共 **591 项：590 通过、0 失败、1 跳过**；server typecheck/build 和隔离重启通过。跳过项是 PostgreSQL 集成测试，原因是没有 `RELATIONAL_TEST_DATABASE_URL`。**CLI 的人工确认仅豁免 R8 Runtime 安全检查，现有独立效果能力策略仍拒绝 CLI，不能将本次交付理解为 CLI 已可实际重跑。** 该限制和未验证项见 §7。

## 1. 服务端行为

仅作用于 `intentContractVersion === 'intent-understanding-v1'`，旧链路继续走原恢复路径。新增集合 `intentReconciliationsBySession`，不改原 resume/retry 的 binding、终态 receipt 或 execution claim。

| 入口／决定 | 实现与结果 |
| --- | --- |
| `GET /sessions/:sessionId/intent-reconciliations` | no-store；从持久化事实发现案件并返回证据、案件／会话版本、动作及禁用原因。查询可保存案件和通知，零认领、零派发。 |
| `POST /sessions/:sessionId/intent-reconciliations/:caseId/decision` | actor／owner、epoch、generation、目标、证据版本和双 CAS；同键同载荷返回幂等结果，同键异载荷或陈旧版本拒绝。沿用本地 owner 边界，没有新增身份认证体系。 |
| `redispatch`：确认没有执行，重新派发一次 | 事务新增本案件本次 attempt，经 `SessionsService.resume()` 和 R7/R8 共用控制／执行路径，再核验原授权、grant、版本、取消／替代、停止、R6 hold、R8 候选／提交／写回和原 operation 预算。派发认领与执行认领分开，重复投递零额外调用。 |
| `confirm_completed`：确认已执行 | 停止确认后，只将绑定 task／nodeRun 记录为人工确认完成，会话进入 `WAIT_USER_DECISION` 并发布结果通知；不生成 Artifact、测试通过、调用成功或写回成功事实，不推进下游／评审／交付。未解决写回或隔离清理仍阻止。 |
| `abandon`：放弃 | 同事务关闭目标派发资格、取消卡片所列 task／nodeRun，保留会话。事务提交后按精确 invocation IDs 调用现有停止端口；不停止兄弟任务，不把未知停止事实写成已确认。旧队列和迟到结果不能覆盖决定。 |

动作②③关闭被替代的原恢复卡，同步 Session／Tasks／WorkflowRuntime 的内存对象，避免后续读写用旧缓存覆盖事务结果。workflow 仅记录绑定节点和 `waiting_human`，不触发推进函数。R8 重派仍只运行绑定的失败任务；R7 继续复用原恢复流程。

## 2. 来源、证据及未知事实

覆盖来源：R7 resume 回执／控制步骤；R8 retryReceipts 及 execution claim；Runtime 安全拒绝；其它 plan-step reconciliation；意图纠错 reconciliation；隔离测试 reconciliation。前三类持有明确 R7/R8 binding 时开放三动作；后三类只读，返回原处理器提示。

证据返回已有的 task／LogicalOperation／invocation 身份和末次状态、时间、停止和活动调用、次数／时间预算、候选／checkpoint、写回、Artifact、相关步骤／纠错事实，连同原 binding 和版本。工作区快照只展示已存事实；**“未归属改动：未知”，“未记录”不等于“未执行”**。不扫描工作区猜测效果归属，也不根据用户消息补造原执行授权。缺失、多解、取消、替代或过期目标保持阻止。

认领后异常或进程重启会保留 attempt 并重新要求对账，不自动重派；即使原恢复卡已消费，已有案件仍参与恢复检查。正常派发与人工决定读取同一持久化案件栅栏；Runtime 启动、结果审计、Orchestrator 结果投影、本地和队列 outcome 均复核。每次 attempt 只允许一次执行认领，并限制同一任务／调用阶段的重复 invocation。

## 3. CLI 确认的准确边界

设计 §4 已先替换为用户批准的规则。只有动作①、只有 `codex`／`claude_code`，请求同时带：

```json
{
  "acceptWorkspaceResponsibility": true,
  "riskVersion": "intent-cli-workspace-responsibility-v1"
}
```

缺字段、错误版本、跨案件、跨 attempt、不同 Runtime 都不能复用。审计 actor、时间、证据 hash、风险版本和 Runtime。`mcp_tool`／`test_runner`／`human` 即使携带确认也拒绝。`assertIntentRetryRuntimeSafe` 函数本身保持原判断，例外只在其调用点核验当前有效 attempt。

**独立能力策略没有放宽。** `packages/shared/src/intent-runtime-policy.ts` 的 `supportsIntentEffectScope()` 仍只支持原有 Runtime／效果组合，`assertIntentInvocationScope()` 会拒绝 CLI。生产边界测试确认：有效人工确认可以越过 R8 Runtime 安全门，但 codex／claude_code 最终因 `INTENT_EFFECT_SCOPE_UNSUPPORTED` 零适配器启动；原失败证据保留于 invocation 审计，未登记的 invocation 结果被标为 superseded。generic_llm 在同一服务端接线中可启动一次，重复调用被拒。没有为得到 CLI 绿例移除 effectScope 或修改范围解析器／能力策略。

## 4. 持久化与并发

File 后端使用现有集合事务及原子文件写入；新案件纳入通用意图记录不变式，保护身份、binding、追加式决定、attempt 身份、CLI 确认、执行 claim 和 invocation 列表。测试覆盖同键并发、不同决定竞争、回滚、File 重载和真实子进程退出后的重新出卡，旧审计保持不变。

关系型表为 `agent_cluster.intent_reconciliations`，迁移 **V24 / intent_human_reconciliation**，接在开工时最新 V23 之后。包含同会话路由外键、session／epoch／source 身份唯一性、状态索引和中文注释；不重写已有表。现有 `INTENT_RECORD_TABLES` 通用装载／写入／作用域／删除路径自动接入该集合，因而没有重复修改 PersistenceService 或 RelationalStateStore。

新增 PostgreSQL 集成测试只从测试 URL 取得凭证，管理连接固定使用 `postgres` 维护库，创建 `agent_cluster_r9a_<pid>_<timestamp>`，测试连接只指向新库，最后 drop／关闭连接。**本次未配置测试 URL，测试 skip；未连接主库 `agent_cluster`，未执行主库迁移。** 脚本已包含独立连接竞争、审计修改回滚和重载断言，但不能把跳过写成数据库验收通过。

## 5. 验证与失败记录

| 检查 | 结果／证据 |
| --- | --- |
| 初始红例 | 当前原型无对账查询／决定 API，exit=1；[red.log](evidence/red.log)。 |
| 边界先红后绿 | 精确停止、进程重启、旧队列迟到结果三项先失败；[gaps-red.log](evidence/gaps-red.log)。实现后纳入最终回归。 |
| 定向存储／来源／workflow | 52 通过、0 失败、1 PostgreSQL 跳过；[storage-2.log](evidence/storage-2.log)。 |
| 生产 Runtime 边界 | 三种 Runtime 定向 3/3 通过；[runtime-boundary-3.log](evidence/runtime-boundary-3.log)。其余 78 项因 name-pattern 跳过，均另纳入最终完整回归。 |
| 最终 spec | **591 项：590 通过、0 失败、0 取消、1 PostgreSQL 跳过，exit=0**；[spec-final.log](evidence/spec-final.log)。 |
| server typecheck | **exit=0**；[typecheck-final.log](evidence/typecheck-final.log)。 |
| server build | **exit=0**；[build-final.log](evidence/build-final.log)。 |
| `npm run dev:restart-server` | **exit=0**；PID 15476→121580，health 正常，runtimeBuildStale=false；[smoke.json](evidence/smoke.json)、[重启日志](evidence/dev-restart-final.log)、[运行日志](evidence/smoke-run.log)。 |
| 源码／dist／保护范围 | 28 份源码和 28 份 server tsc 输出；9 个受保护文件未变，双端无变更；[verification.json](evidence/verification.json)、[capture.log](evidence/capture.log)。 |

最终 18 文件均在 `apps/server/src/modules/`，后缀 `.spec.ts`：

```text
message-routing/intent-reconciliation.service
persistence/relational/intent-reconciliation.integration
persistence/relational/relational-schema
message-routing/intent-plan-commit.service
message-routing/intent-resume-guard
message-routing/intent-retry-guard
message-routing/intent-message-pipeline.service
orchestrator/intent-retry-task
orchestrator/orchestrator.service
sessions/sessions.service
workflows/workflow-runtime.service
execution/execution.service
queue/execution.worker
runtimes/runtime.service
runtimes/generic-llm-input-budget
runtimes/input-budget-store
runtimes/input-budget-tool-rerun
runtimes/generic-llm-tool-loop-budget
```

命令：`node node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json --test --test-concurrency=1 --test-force-exit <上述文件>`；以及 `npm run typecheck -w @agent-cluster/server`、`npm run build -w @agent-cluster/server`。R6 五文件全部纳入；既有 `generic-llm-tool-loop-budget.spec.ts` 本次无失败。测试适配器为本地桩，不发真实模型请求。

中间记录全部保留：初次 typecheck 的可选值／Artifact 字段／空串联合类型错误、第二次的 schemaVersion 字面量错误均已修复；单测两次调整了“清空恢复卡后应拒绝”的错误码预期。File 夹具从非法插入终态 receipt 改为真实 running→reconciliation_required，不放宽 R8 不变式。第一次合并回归的唯一失败为 schema 注释测试未包含 V24 SQL，修正后通过。CLI 首次正例暴露原有独立效果策略限制，修正测试断言并明确记录限制，没有放宽产品守卫。跨进程夹具初次使用 tsx eval 未生成文件，改为独立 `.mts` 文件且移除子进程继承的 NODE_TEST_CONTEXT 后验证实际文件和进程退出。详见 `unit-initial`、`unit-2`、`unit-3`、`typecheck-initial`、`typecheck-2`、`spec-combined-1`、`runtime-boundary-1/2`、`storage-1`、`crash-2/3` 日志。

冒烟使用随机独立端口 56872 和独立临时 File 数据目录，只对子进程设 mock／禁用自动 Local Runtime／不可达模型连接；`.env` 未改。新 GET／POST 路由均返回 `SESSION_NOT_FOUND`，证明路由注册成功而非框架路径缺失；预算非法请求仍为 400。创建 Session、invocation、真实模型调用均为 0。进程树已关闭，临时证据数据留存。该项只证明启动／重启／接口注册，不冒充三动作 HTTP 业务端到端或真实模型验收。

## 6. 改动范围及设计 §6 外文件

28 个源码／测试文件的完整路径及 SHA 均在 manifest。主改动为 shared 合同、三个 reconciliation 实现文件及 spec、resume/retry 控制和守卫、Sessions API／DI、Orchestrator／Runtime／执行／队列栅栏、持久化不变式和 V24。以下为设计 §6 未逐名列出的配套改动：

| 文件 | 必要性与边界 |
| --- | --- |
| `packages/shared/src/intent-correction-contracts.ts` | 原 resume/retry binding 增加可选 attempt ref，保留原 binding 身份。 |
| `message-routing/intent-reconciliation-state.ts`、`intent-reconciliation-evidence.ts` | 分离持久化认领／栅栏与事实汇总，无自动对账。 |
| `message-routing/intent-execution-guard.ts` | 现有启动及结果授权检查加入案件栅栏，默认旧链路不变。 |
| `message-routing/intent-resume-guard.ts` | 对账恢复复用原授权、版本和预算核验，比较原 binding 时仅剥离 attempt ref。 |
| `execution/execution.service.ts` | 与队列相同的本地执行分支传递 ref，并拒绝迟到 outcome。 |
| `runtimes/logical-operation-store.ts` | 同一个原 operation 携带 ref；不新建预算、不重置次数／期限。 |
| `runtimes/runtime.service.spec.ts` | 验证实际 Runtime 调用点、generic 一次启动和 CLI 独立能力阻止，避免只测纯函数。 |
| `tasks/tasks.service.ts` | 人工决定提交后同步已有 task 对象，不把旧缓存再持久化。 |
| `workflows/workflow-runtime.service.ts` | 仅同步人工决定后的 run／node 状态缓存，不调用推进／评审／交付。 |
| `persistence/relational/postgres-migration-runner.ts` | 注册 V24，不改历史迁移。 |
| `persistence/relational/relational-schema.spec.ts`、`intent-reconciliation.integration.spec.ts` | 注释／约束回归与严格一次性库的集成测试。 |

上表服务端相对路径前缀为 `apps/server/src/modules/`。设计、报告／证据、`.cache/supervisor/r9a-smoke.mjs`、`r9a-capture-delivery.mjs` 和收件箱结果为配套交付。监督文档的既有改动及工作区其它 HTML／临时文件未纳入本轮，也未覆盖。

编译器、execution-scope-resolver、提交层、semantic-intent-router、Runtime 默认配置、默认 capability／agent presets、`.env`、`intent-runtime-policy.ts` 均未修改。Web／desktop 未改、未跑双端测试；本轮为 R9a。

## 7. 冻结与剩余限制

聚合方法：路径排序后对 `{path,sha256}` 数组 `JSON.stringify` 并计算 SHA-256；dist 路径为 server tsc 实际输出 `apps/server/dist/<source path>.js`。

| 项目 | SHA-256 |
| --- | --- |
| 28 文件源码聚合 | `fa4cec7e7aad632e562c2aa9549e134cee4f6b2681be77c091929e50165ab70b` |
| 28 文件 dist 聚合 | `cd57003ac4ada54b2e3737b673b27117aa86b49e3e78a2c12676a9be3e1aa5d0` |
| verification.json | `a3bf37fbc65affad6fe595052fe35084889d58511b7a1004c5147aa6cff0cff2` |

1. **CLI 实际执行仍受独立效果能力策略阻止**，人工确认没有取得额外效果授权，未解除该限制；详见 §3。其它 Runtime／候选／写回／停止／授权守卫仍可能使动作①不可执行。
2. PostgreSQL 实库竞争／迁移未运行；Redis 多进程故障、真实 CLI／模型、工作区效果归属、完整 HTTP 三动作业务链均未实测。File 跨进程退出和逻辑队列测试不等同于这些验收。
3. R9b 确认卡和双端交互尚未实施；服务端提供接口／事件。其它来源只读，仍须原纠错／隔离清理／计划处理器解决；没有新增通用自动恢复或工作流功能。
4. 缺原授权、缺唯一目标、过期版本、未确认停止、耗尽的原预算不会因人工“没有执行”而自动修复。人工“已执行”只记录人的决定，不证明输出正确；未知工作区归属继续明确为未知。
5. 本轮没有改提示词、评测题目、默认链路或识别准确率报告，也未跑真实模型。交付后停止，等待监督方复核。

## M-008 A：PostgreSQL 补验（2026-10-21）

利用已运行的 `agent-cluster-postgres`，在子进程环境中传递连接凭据，四个集成文件串行运行，每个文件分配一个新建一次性库并在 finally 中删除；R9a 文件自身另建／删除独立库。`intent-reconciliation` 1/1、`intent-correction` 1/1、`intent-semantic-transactions` 15/15、`postgres-migration-runner` 20/20，合计 **37/37 通过，0 失败、0 跳过**，未改服务端源码或测试。主库连接强制只读：会话数 **16 → 16**、`deleted_at` 非空数 **4 → 4**、最新迁移 **22 → 22**，三项前后相同；没有向主库执行测试或迁移。脱敏完整日志见 `evidence/postgres-integration.log`。此补验取代 §7 第 2 条中“PostgreSQL 实库竞争／迁移未运行”的限制，其余未测项保留。
