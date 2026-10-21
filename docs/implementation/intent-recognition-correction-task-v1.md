# 意图识别、路由与纠错 Task v1

[工作流节点作用域编译](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/workflow-node-scope-report.md)已实现声明保留/发布哈希、父权限交集、禁止项继承及全节点失败不返回部分计划；相关 23 项通过。选择事务、编辑 UI 和 Runtime 派发仍待接入，整组未完成。

[工作流选择绑定基础](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/workflow-selection-binding-report.md)新增严格合同与确认后上下文绑定，相关 42 项通过。尚未接入选择 API 或节点执行，不作为专业工作流完成证据。后续设计见 docs/design/intent-workflow-selection-design-v1.md。

[审阅失败恢复 HTTP 增量](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/reviewer-recovery-http-report.md)覆盖独立预算耗尽、仅失败目标显式重试、成功意见保留、并发单收据和服务重启回放；修复同版本失败被其他审阅进度覆盖。不是准确率或强杀崩溃矩阵证明，完整验收保持未完成。

[逐目标恢复展示增量](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/reviewer-recovery-report.md)已补齐失败 Agent 名称、仅重试当前步骤及单人完成不等于新稿完成的文案；组件 6 项、后端相关 40 项通过，实际双端和完整矩阵仍未验收。

指定审阅入口与真实调用增量见[报告](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/directed-brief-entry-report.md)：结构化名单绑定、逐目标调用/显式重试、全部意见后定稿及真实 HTTP 7 项已通过。前述“入口未启用/仅手动提交意见”为历史阶段；逐目标恢复 UI、PostgreSQL/双端矩阵及完整 SDD 仍未完成，不整体勾选。

指定修订的结果基础继续推进：[审阅结果事务与定稿依赖](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/directed-brief-store-report.md)。已接版本化意见保存/发布、完整目标依赖核验、定稿等待及意见上下文；生产指派受理、真实审阅 Runtime 和逐目标恢复仍待完成，不勾选整项。

指定修订的下一实现依赖已固定：[版本化定向修订设计](../design/intent-directed-brief-revision-design-v1.md)。已加入内部审阅动作、完整目标派生和定稿依赖；未安装执行器时明确阻止运行。此为 IR06/IR09/IR10 基础增量，不能视作指派修订功能完成。

当前草稿失败恢复：[显式重试记录](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/brief-retry-report.md)。IR06/IR09/IR10 增加 CAS 重试、历史预算收据、旧操作启动屏障、状态查询与双端共享入口。Server 2212 + 7、最终专项 35、Web 538、PostgreSQL 36、实际 HTTP 6 通过；完整指派修订、专业执行和验收门仍未完成。

当前结构化修订增量：[草稿修订与逐题回答](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/brief-revision-report.md)。IR06/IR08/IR09/IR10 已接绑定原稿的统一入口、事务问答、替代草稿与双端共享请求恢复。Server 2204 + 7、最终后端 72、Web 533、最终客户端 15、PostgreSQL 36、HTTP 6 通过，范围分别记录。指定生成 Agent、完整复杂修订和专业执行未完成，整组不勾选。

当前纠错到 Brief 增量：[新版本草稿](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/brief-correction-report.md)。IR06/IR08/IR09 已接纠错激活同事务派生、替代目标绑定、暂停等待、旧卡失效、迟到结果拒绝和有效约束投影。实际 HTTP 六项及独立 PostgreSQL 36 项通过，完整结构化修订表单、专业执行和整组验收仍未完成。

当前 Brief 确认增量：[版本化确认](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/brief-confirmation-report.md)。IR06/IR09/IR10 已接事务确认、共享双端请求绑定、暂停检查点、不可变收据和幂等恢复。Server 2192 + 7、最终专项 185、Web 528、最终客户端 10、Shared 285、PostgreSQL 36、HTTP 10 通过，各次源码范围见报告。修订和确认后的专业执行仍未完成，整组不勾选。

当前 Brief 执行增量：[首轮自动草稿](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/brief-executor-report.md)。IR06 已从真实首轮提交自动派生、领取、调用并发布 Brief，租约/预算/重启恢复和旧缓存保护已接入；实际 HTTP 6 项通过。旧确认/修订明确拒绝旁路业务，新确认后的执行、复杂任务/效果和完整环境矩阵仍未完成，IR06 与阶段门不整体勾选。下方“未注册执行器”为历史基础切片范围。

当前 Brief 基础：[草稿事务与版本守卫](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/brief-store-report.md)。IR06/IR09 新增服务端派生步骤、受限 Runtime 合同和保存/发布事务；父步骤、完整计划、租约、epoch、Decision 与暂停状态均重验。尚未注册自动派发服务、接模型生成/确认后执行或迁移旧 Brief 缓存，不把存储夹具当作真实入口完成，IR06 保持未勾选。

当前指定回答增量：[全部明确目标的独立回答](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/targeted-answer-report.md)。IR04/IR06/IR09 的单段多 Agent 回答已接纯编译、原子计划、目标运行身份、持久化执行和部分失败聚合。Server 2162 + 7、HTTP 5、独立 PostgreSQL 34 项通过。未开放多段执行；其他效果、完整双端/崩溃矩阵与独立模型评测仍待完成，整组不勾选。

当前 Claude 增量：[服务端受限分类](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/claude-classifier-report.md)。IR03/IR04.4 已接实际 Worker 与原生 CLI，空工具/隔离上下文、单层两次预算及重复分类幂等有 8 项真实进程与确定性响应证据。Codex/Bridge、模型准确率及完整环境矩阵仍未完成，IR04.4 不整体勾选。下面各次记录保留历史范围。

当前多段展示增量：[完整澄清诊断](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/multi-segment-review-report.md)。IR04.4/IR10.4 已补全完整提案的事件/Outbox 与双端展示、状态核对和严格 CSP 兼容。全量 3109、最终 Web 523、HTTP 6、浏览器组件 11 项通过；仍无自动多段执行，真实 CLI、完整复杂澄清及全部环境矩阵未完成，整组不勾选。

当前恢复增量：[原消息显式重新识别](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/recognition-retry-report.md)。IR03/IR09/IR10/IR12 已补失败历史归档、新有限预算操作、原文绑定、旧操作隔离、共享客户端固定回执和真实连接等待期。工作区 3097 项通过、37 项条件跳过；独立 PostgreSQL 32/32、实际 HTTP 7/7。这里只验证确定性恢复机制，完整模型准确率、环境矩阵和整组任务仍未通过，不新增整组勾选。

当前首轮增量：[首轮测试与显式授权重校验](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/authorization-retry-report.md)。缺授权不建任务/Brief；用户明确重校验后保留原语义、零新增模型调用，原诊断和新计划/任务/step/回执原子保存。工作区全量 3081 通过；最终 UI 13、HTTP/Docker 8、PostgreSQL 30 通过。只覆盖受限单测试/报告及共享客户端，真实模型准确率、复杂执行和完整环境矩阵仍待完成；IR04–IR06/IR09 与 IA03 不整体勾选。

当前报告纠错增量：[已发布报告的对账与替代](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/report-correction-report.md)。已完成报告进入影响集合，对账验证历史证据并保留原产物；新授权计划生成关联报告，保存失败恢复不重跑。相关 64、Server 2129 + 7、Shared 282、Web 497、真实 HTTP/Docker 14、PostgreSQL 28 项通过。只覆盖平台生成的隔离测试报告，通用补偿及完整 IR08/IR09/IR11 不勾选。

当前报告执行增量：[隔离测试报告授权与事务发布](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/test-report-report.md)。独立 writeReport 授权、同 runner 效果绑定、成功/失败报告原子发布、撤权守卫、日志恢复和双端展示已实现。Server 2123 + 7、Shared 282、Web 497、真实 HTTP/Docker 10、浏览器 6、PostgreSQL 28 项通过。只覆盖既有 WorkItem 的受限测试报告，IR05.2/4、完整 IA03 和发布门仍不勾选；以下“尚未接入报告”属于对应历史里程碑。

当前产物前置：[报告执行的事务存储基础](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/artifact-transaction-report.md)。移除产物服务旧 Map 覆盖、创建等待事务、删除/epoch 守卫及可组合 draft helper 已完成；Server 2117 + 7、相关 262、PostgreSQL 26、旧入口 HTTP 4 项通过。报告授权/执行器尚未接入，IR05.2/4 和 IA03 不勾选。

当前数据库增量：[真实 PostgreSQL 意图事务验证](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/postgres-intent-report.md)。原 21 项不再跳过，新增澄清/纠错 SQL 回滚及独立连接竞争 4 项，最终 25/25 并在新数据库复现；File 相关 65/65。修复删除准入错误被意图错误覆盖。只补齐局部 PostgreSQL 证据，IR07/IR12 的完整环境、迁移和进程故障矩阵保持未完成。

当前澄清增量：[新语义合同结构化澄清](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/semantic-clarification-report.md)。首轮无 WorkItem 可确认关系；有限分类预算、恢复、继承约束和最终事务收据已接通。相关 65、Server 2113 + 7、Shared 281、Web 493、实际 HTTP/重启 8 项通过。仅单段关系澄清，复杂澄清、其他执行效果和完整环境验收未完成，整组不新增勾选。

当前执行增量：[版本化纠错后测试派发](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/correction-test-dispatch-report.md)。原纠错 API 和普通聊天已支持受当前授权约束的单测试步骤：激活事务保存 queued，提交后执行，暂停不恢复，重放/通知丢失恢复不重复调用。真实 HTTP/Docker 11 项与相关 83 项通过。源码/产物/外部效果及完整环境矩阵未完成，整组 IR05–IR10 保持未勾选。

当前增量入口：[运行中隔离测试纠错对账](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/correction-reconciliation-report.md)。旧隔离测试有完整停止/清理凭据后可激活事务内纠错；分类后提交再次核验，不复用过期证据。带执行效果的新纠错计划仍待派发，IR07–IR09 不整体勾选。下方“最新”段落按各历史里程碑理解。

最新回答增量：[已提交回答计划的执行与发布](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/answer-executor-report.md)。新增绑定持久化 step 的 response 准入、无工具回答执行、两次共享预算和单次修复、迟到结果拒绝、原子回复/Outbox、File 重载复用结果。Server 2022 + 7、Shared 280、相关 118、实际 Nest/HTTP 10 项通过，最终状态增量另有 24 项回归；21 PostgreSQL 跳过。首轮/普通 Sessions 尚未迁移，IR06.1/G2 不勾选；细分源码范围见报告。

最新提交增量：[新语义计划事务提交](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/plan-commit-report.md)。已接不可变计划/step/事件的原子提交、有限事务内动作、queued 回答、制品快照及引用归属、约束变更 epoch 屏障与 shadow 零业务效果。Server 2013 + 开发脚本 7 通过/21 PostgreSQL 跳过；最终相关回归 51、事件 Store 13、Nest/HTTP 7 项通过。IR04–IR07 的完整入口/执行器依赖和 IR11 ordered_plan 仍未满足；生产 Sessions 尚未切换，整项不新增勾选。

> 日期：2026-10-19。状态：实施中；已完成切片及范围见 Checklist 的 SDD-2026-10-19 开发记录。
> 四件套：[Spec](../product/intent-recognition-correction-spec-v1.md) · [Plan](../design/intent-recognition-correction-plan-v1.md) · [Task](intent-recognition-correction-task-v1.md) · [Checklist](../quality/intent-recognition-correction-checklist-v1.md)。
> 继承：[原 IR00–IR13 开发分组](intent-recognition-correction-development-v1.md)。本文将 14 组细化为 56 个执行切片，不改变原编号含义。

## 1. 执行规则

每个切片按“读取对应 Spec/AC → 固定前提与可失败断言 → 最小实现 → 验证实际效果 → 写 Checklist 证据”执行。已有问题先保留失败复现；新合同先补合同/负向测试。不要为文档格式修改增加业务测试，也不要为了通过而放宽安全断言。

Task 中勾选表示该切片实现及对应验证均完成，必须关联 Checklist 的实际 run-id/证据；不能因文件创建、类型通过或模型输出合法而勾选。若缺数据库、Runtime 或客户端条件，记录阻塞，不把 mock 验证冒充真实验证。

每个切片通常是一组可独立检查的变更，不承诺固定 10–15 分钟完成。高耦合文件保留现有修改，禁止全文件覆盖或顺带重构。目录简写均相对仓库根目录；下文 server 模块位于 `apps/server/src/modules/`。

## 2. 基线 B0

### IR00：冻结基线和判分标准

依赖：无。规格：IRC-R17、IRC-R18、IRC-R19。输入：原评测三份文档、当前 Git diff、相关测试 manifest。产物：新的基线 manifest、版本化 gold/判分说明。

- [ ] **IR00.1** 保存 SHA、dirty diff 指纹、运行模式、依赖/Runtime 和配置来源；检查源码已与设计不同的入口。验证：可重现相同代码边界，凭据不进报告。
- [ ] **IR00.2** 映射原 T/F/C/S/V/H/L 题至 IA/IC/IF；固定 L17 安全拒绝、L20 缺前提、L20B 完整前提及多意图 oracle。验证：原结果不改写，新判分版本独立保存。
- [x] **IR00.3** 复核原 339 项相关回归及关键已知失败，记录实际文件清单/命令/结果。验证：区分既有问题、实现回归和环境阻塞。
- [ ] **IR00.4** 建立隔离 Session、确认卡、真实失败检查点、文件 hash 和效果收据 fixture。验证：状态不能只手改枚举；无生产副作用。

退出：G0；基线清单和重现依据在 Checklist 可查询。

## 3. 安全修复 B1

### IR01：统一服务端硬校验

依赖：IR00。规格：IRC-R05、IRC-R06、IRC-R20。路径：`intent-recognition/semantic-intent-router.service.ts`、`message-routing/{command-state-resolver,route-application}.service.ts`、`context-management/context-management.service.ts`；新增 intent-policy 服务及 spec。

- [x] **IR01.1** 建立关系/动作/上下文允许组合的纯校验和反例，覆盖独立需求却继续旧任务。验证：IA18 无计划提交，正常组合不被误拒绝。
- [x] **IR01.2** 内部确定性分支复用 CommandStateResolver，删除重复状态标准。验证：IA11–IA16 在真实入口与内部调用一致，精确命令零模型调用。
- [x] **IR01.3** 风险与授权证据由服务端判断，分数仅诊断；校验 @、引用和快照。验证：IA17–IA22，明确 pause/cancel 保留快速控制。
- [ ] **IR01.4** 把校验接入旧主路径、新路由与提交前边界，禁止调用者伪造 safeToApply。验证：不能仅修 shadow；缺硬条件的人工/模型路径均不派发。

退出：IRC-AC05、IRC-AC06 的相关回归通过；无新增命令回归。

### IR02：澄清原子绑定和冲突

依赖：IR00；调用共享策略部分依赖 IR01。规格：IRC-R08、IRC-R13。路径：`sessions/{sessions.controller,sessions.service}.ts`、`context-management/`、`message-routing/route-application.service.ts`、Shared 合同。

- [x] **IR02.1** 定义 confirmationId、expectedRoutingRevision、canonical choice/payload 和幂等键合同，补严格请求验证。验证：IC04–IC07，无效确认不落业务效果。
- [x] **IR02.2** 在同一持久化事务内检查 receipt、同/反选择、版本和时效，移除已 ROUTED 无条件成功返回。验证：IC01–IC03 顺序/并发均单一效果或明确 409。
- [ ] **IR02.3** 原子提交确认解决、计划/任务、receipt 与 Outbox；相同网络重放先查既有收据。验证：丢响应/重复请求不重复创建，后续已纠正卡片明确失效。
- [ ] **IR02.4** 仅对可唯一绑定的旧客户端请求适配，关系确认后重验继承与执行权限。验证：IC05–IC07，不任意绑定当前卡、不通过关系选择授予写权限。

退出：IRC-AC08；File 并发集成通过，PostgreSQL 结果在 IR07/IR12 补全后才能声明全 backend 通过。

### IR03：错误分流和持久化重试预算

依赖：IR01。规格：IRC-R12、IRC-R16。路径：SemanticIntentRouter、Sessions 重试调度、`runtimes/logical-operation-store.ts`、RuntimeInvocation 相关服务。

- [ ] **IR03.1** 区分 transient/auth/config/schema/semantic/stale/unknown-effect，系统错误转 blocked；移除异常后的可执行业务规则兜底。验证：IF01–IF02。
- [x] **IR03.2** Schema 修复附具体字段错误、受限原输出及原输入引用，最多一次，并重跑全校验。验证：IF03–IF04；修复不改变权限或用户目标。
- [ ] **IR03.3** 分类、修复、快照重建和队列恢复共享同一 operation 的 attempts/deadline。验证：IF04–IF05，总调用不相乘；401 不重复同连接。
- [ ] **IR03.4** 记录 attempt 原因、用量/传输次数未知以及停止未确认的阻塞。验证：IF16、IC10，父进程请求计数为零不被解释成没调用模型。

退出：IRC-AC12 的服务测试通过，G1 安全修复证据齐备。

## 4. 统一语义 B2

### IR04：新语义合同与计划编译

依赖：IR01。规格：IRC-R02、IRC-R04、IRC-R14、IRC-R20。路径：`packages/shared/src/runtime-contracts/`、`contracts.ts`、SemanticIntentRouter；新增 `message-routing/route-plan-compiler.service.ts`。

- [x] **IR04.1** 注册 intent_understanding 1.0，定义严格的 segment/target/effect/prohibition/evidence/correction/dependency，更新 exports/instructions/mock。验证：未知字段、越界长度和依赖环被拒绝，不影响 task_execution_result 2.0。证据：SDD-2026-10-19 的 semantic-contract-plan.log 与 Shared 全集；这里只完成合同切片，主分类入口切换及三 Runtime 集成仍归 IR04.4/IR06。
- [ ] **IR04.2** 快照候选和原文区间服务端核验，保持全部明确 @；附件和历史不作为新授权。验证：IA20–IA22、IF12、IRC-AC20。
- [ ] **IR04.3** 编译有限动作与上下文策略，覆盖否定新任务、相关选择继承和独立清理。验证：IA05–IA10、IA18；保留有效约束，无自由文本派发。
- [ ] **IR04.4** 多目标全部结构化，默认 clarify；补 Generic/Codex/Claude 合同传递集成。验证：IA14、IF12–IF13，第二目标不丢失，不静默截断执行。

退出：IRC-AC02、IRC-AC04；合同实现和 Runtime 传递具有各自证据。

### IR05：效果范围与实际执行授权

依赖：IR04。规格：IRC-R03、IRC-R06、IRC-R20。路径：新 `runtime-routing/execution-scope-resolver.service.ts`、InvocationResolver、ToolAuthority、`runtimes/cli-tool-authority.ts`、Adapter/Bridge 与写回调用点。

- [ ] **IR05.1** 实现有效授权与阶段/工具/工作区/Runtime 能力交集，应用对象明确的禁止项。验证：IA01–IA05；不把“不改表”误禁全部代码修改。
- [ ] **IR05.2** 迁移 requiresCodeChanges 权限读取点，拆开 source/artifact/test/command/external 能力。验证：IA03 报告可写、源码不变，Workflow 和子任务不扩大范围。
- [ ] **IR05.3** 修复 CLI 测试绑定 writeMode 的逻辑，能力传到实际 sandbox/工具/Bridge；不支持约束则 blocked。验证：IA24、IF14，检查真实文件 hash/调用而非 Prompt。
- [ ] **IR05.4** 候选 ChangeSet/写回门校验局部禁止及当前 scope，继承权限带版本。验证：schema 变更不被误写回、产物保存不授予源码写回。

退出：IRC-AC03；实际效果验证通过后才能对外宣称只读/评测权限隔离。

### IR06：首轮和普通消息统一入口

依赖：IR03、IR05。规格：IRC-R01、IRC-R05、IRC-R07、IRC-R12、IRC-R20。路径：Sessions、MessageIngress、ContextManagement、LogicalOperation、恢复/source-ready/Autopilot 启动调用点。

- [ ] **IR06.1** 首轮原子接入 routing，延后初始 WorkItem 和 Brief；允许 answer/clarify/reject 没有 WorkItem。验证：IA01–IA03、IF02；首轮所有派发都有计划。
- [ ] **IR06.2** 加 routing/business 准入区别，受限识别不开放业务 admission/generation。验证：IA23、IC10；停止未知/删除/epoch 错误不启动新进程。
- [ ] **IR06.3** 快照增加入口、纠错候选、授权/禁止、检查点/效果摘要及遗漏；指纹只含业务事实。验证：IA22、IRC-AC20；心跳不触发无限重建。
- [ ] **IR06.4** 接通 BLOCKED、恢复轮询和所有后台启动守卫；暂停时旧规则计划恢复后重判。验证：无提前 Brief/来源未就绪派发、无系统错误伪澄清。

退出：G2；IR10 的相应消费者接通后完成双端入口验收。

## 5. 版本化纠错 B3

### IR07：版本实体、迁移和持久化

依赖：IR02、IR04。规格：IRC-R09、IRC-R10、IRC-R11、IRC-R13、IRC-R18。路径：Shared、ContextManagement、Persistence、relational schema/store、scope 和迁移工具。

- [ ] **IR07.1** 定义 routingRevision/intentRevision/requirementRevision/executionEpoch，新增 routeRevision/resolution/correction/planStep 实体和唯一键。验证：版本用途不混用、不可变 payload 不覆盖。
- [ ] **IR07.2** 接入 File collections、关系映射、索引、Session/epoch 删除与作用域限制。验证：读写 round-trip、跨范围引用拒绝，无内存独占屏障。
- [ ] **IR07.3** 增加 additive 迁移/dry-run、旧 resolution 字段迁移、缺权限 unknown 的处理。验证：副本迁移可重复运行，不伪造旧选择/授权。
- [ ] **IR07.4** 对两 backend 注入提交失败与并发，确认 receipt/ledger/plan/outbox 等价。验证：IC03、IC14、IF08，无半提交状态。

退出：IRC-AC13/18 的存储部分通过；缺 PostgreSQL 环境明确阻塞。

### IR08：纠错 API 与约束替换

依赖：IR07。规格：IRC-R09、IRC-R10。路径：新增 IntentCorrectionService、Sessions corrections API、ContextManagement Ledger mutation。

- [ ] **IR08.1** 新纠错 API 校验目标/版本/幂等，普通聊天纠正转同服务，模糊目标先澄清。验证：IC08、IC17–IC18；不能修改其他会话或冻结无关任务。
- [ ] **IR08.2** 接收事务立即保存 route/WorkItem hold/epoch 和旧排队失效，之后再请求 stop/模型。验证：IC08–IC10、IF07；失败/超时不自动释放屏障。
- [ ] **IR08.3** 抽取 Decision draft mutation：校验旧 revision、追加新决定并 supersede；继承决定采用局部 override。验证：IC12–IC15，Context/Brief 实际排除旧约束。
- [ ] **IR08.4** 完成纠错状态机和新版本激活事务，区分未派发/运行/已完成/效果未知。验证：IC09–IC11、IC17；202 与 applied 分开，外部效果不伪撤销。

退出：IRC-AC09/10；真实停止和执行联动需 IR09 闭环。

### IR09：执行、回调与写回版本守卫

依赖：IR05、IR08。规格：IRC-R03、IRC-R07、IRC-R11、IRC-R13。路径：AgentTask/InvocationPlan/receipts、Dispatcher、RuntimeInvocation、Adapter 启动、恢复及结果写回。

- [ ] **IR09.1** 派发绑定 routing/intent/requirement/epoch/sessionGeneration/decisionSetHash/effectScopeHash，reserve 和 Adapter 启动前复核。验证：旧 queued step 不启动，纠错边界竞态可停止/对账。
- [ ] **IR09.2** 结果事务检查 binding，过期成功/失败/ChangeSet 只入审计，不发旧下一步。验证：IC16，无旧写回、新状态不被覆盖。
- [ ] **IR09.3** 对接既有 stop 生命周期和 unknown-effect 查询，恢复 hold/receipt/剩余预算。验证：IC10、IF05、IF07；进程重启不重放未知效果。
- [ ] **IR09.4** 验证 Session 删除、epoch 切换、Outbox 重发和延迟回调。验证：IF06、IF09；不复活旧会话、不重复效果。

退出：IRC-AC11/13 的实际执行与故障证据完成。

### IR10：Web/Desktop 绑定、状态与纠错入口

依赖：IR06、IR08；可随 B2 先接识别/blocked，最终合并验收须齐备。规格：IRC-R01、IRC-R08、IRC-R09、IRC-R15。路径：Shared/API、`apps/web/src/stores/session.ts`、两端 SessionWorkspace、ConfirmationCard。

- [ ] **IR10.1** API/Store 绑定原 session/routing/confirmation/revision/idempotencyKey，重试使用同一 payload。验证：双端 IC01–IC07，无读当前选择造成错绑。
- [ ] **IR10.2** 展示识别中、语义澄清、系统 blocked 和 409/410；收到冲突刷新当前事实。验证：无静默成功、不因 401 逼用户重选关系。
- [ ] **IR10.3** 增加关联原消息的纠错入口与接收/停止中/待对账/生效反馈。验证：IC08–IC11、IC17–IC18，普通用户不需理解内部版本号。
- [ ] **IR10.4** 注入双客户端重复/反选择、刷新和 SSE 乱序/丢失，实际 Web 与 Electron renderer 验证。验证：eventId 去重、revision 不倒退，恢复后能核对最终事实。

退出：G3；无真实 Electron/数据库等证据时不得把全范围 G3 勾选完成。

## 6. 有序多段 B3-O（可独立延后）

### IR11：逐段执行与跨版本效果复用

依赖：IR09。规格：IRC-R14。路径：RoutePlanCompiler、step 持久化、Dispatcher、恢复和多意图客户端展示。

- [ ] **IR11.1** 定义 route_committed/execution_completed 依赖，校验唯一 localKey、引用、无环和上限。验证：IF12，超限/冲突不截断后执行。
- [ ] **IR11.2** 原子保存全计划、按依赖逐段执行，首段失败默认阻止依赖段。验证：IA14、IF10；不把“继续”代成 Brief 批准。
- [ ] **IR11.3** 同版本 step 幂等，跨纠错版本明确 reusedEffectIds 并核对目标/效果。验证：IF10–IF11，失败段重试不重做已完成段。
- [ ] **IR11.4** 多意图开关由服务端执行，验证明确暂停的可靠分离与否定边界。验证：IF13；默认 clarify 无法被客户端绕过，ordered_plan 证据齐备后才启用。

退出：G3-O。未实施时保留所有勾选为空，在 Checklist 标能力未启用；不能把可选能力的未实现写成已通过。

## 7. 质量与收敛 B4

### IR12：完整验收、审计与独立评测

依赖：IR09、IR10，以及已启用的 IR11。规格：全部；重点 IRC-R16、IRC-R17。路径：相关 spec、`tests/evaluation/`、`tests/e2e/`、审计指标及质量证据目录。

- [ ] **IR12.1** 执行启用范围 58 场景、原 339 项相关回归和仓库阶段检查，按状态/Runtime/backend/客户端分层。验证：失败/跳过/阻塞逐项记录，不拿旧通过数代替当前运行。
- [ ] **IR12.2** 验证审计从输入到 effect 可追踪、版本/权限/attempt 完整；用量未知与真实零区分，检查凭据泄漏。验证：IRC-AC16 和真实运行审计。
- [ ] **IR12.3** 建立 500+ 独立封存题、两人标注仲裁、会话级隔离，固定版本运行至少 3 次。验证：动作/关系、macro-F1、召回、澄清、继承、多段和纠错最终效果指标及置信区间。
- [ ] **IR12.4** 汇总 File/PostgreSQL、双端、真实模型/实际执行各自范围，形成可发布或受限使用判定。验证：G4；缺环境不变成通过，未达门不扩大 enforce。

退出：G4；报告能复现全部结论、揭示限制。

### IR13：兼容发布、灰度与旧路径退出

依赖：IR12。规格：IRC-R18、IRC-R19。路径：发布/迁移配置、旧分类调用点、合同与运维文档；实际外部操作按环境授权。

- [ ] **IR13.1** 演练副本迁移与混合 worker，固定读兼容→服务/worker→双端→新写入顺序。验证：旧 worker 不处理新合同；历史 unknown 不补写权限。
- [ ] **IR13.2** 固定 shadow/enforce cohort、多段开关和回滚目标，在隔离/获授权环境比较主旁路。验证：shadow 零业务效果，配置在 routing 审计中可见。
- [ ] **IR13.3** 证明旧 handlingPlan/free text 分类消费者全部迁移后，删除重复 Coordinator 分类与危险规则兜底。验证：回滚仍保留硬校验、hold 和新记录读取。
- [ ] **IR13.4** 形成部署/放量/回滚检查记录并同步合同及功能状态；在获得具体环境授权后实施和观察。验证：G5；未授权或未观察时保持待执行，不把文档批准当作生产发布许可。

退出：G5 和启用范围全部 AC 完成，才可声明专项交付。

## 8. 每个切片的交付记录

在 Checklist 的 run 记录中填写：taskId、关联 IRC-R/AC、基线 SHA/dirty diff、改动路径、失败复现、实际命令与退出码、效果证据、未验证项和下一依赖。任务中发现必须改变行为时先修改 Spec/Plan；遇到纯实现缺陷回到本切片，不重新定义“正确”。

实施记录：[SDD-2026-10-19](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/README.md)。当前勾选仅代表对应切片与已注明范围验证完成，B1/B2 阶段门及整个专项尚未完成。继续按 B1→B2→B3→B4 推进；B3-O 未启用。

版本化纠错增量：[执行屏障开发记录](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/versioned-correction-report.md)。IR07 已加入四类实体、V23 additive 映射、不可变保护、删除与初始化清单；IR08.1/IR08.2 已接 API 和接收事务；IR09.1 已接预约/启动前持久化屏障。

后续增量：[纠错激活、结果和写回记录](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/correction-activation-report.md)。IR03.3/IR08.3/IR08.4 已接持久化分类预算、无执行效果的单段纠错激活、Decision 替换与局部继承覆盖；IR09.2/IR09.4 已接 Runtime 过期结果审计、阻止旧业务 outcome、写回准入与已准入写入的对账屏障。普通聊天、执行型纠错、全部业务投影事务、完整 PostgreSQL/CLI/客户端验证仍未完成，整项保持不勾选。

客户端增量：[原消息纠错入口开发记录](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/correction-ui-report.md)。IR10.1–IR10.3 已新增双端共享面板/Store、原消息持久化查询、同 payload 重试、冲突刷新、版本防倒退及受理/对账/生效反馈。Web 466 项、Session 148 项及 9 项 HTTP 检查通过；实际浏览器仅验证隔离组件 fixture。普通聊天/无目标纠正和真实 Web+Electron 双客户端及 SSE 故障注入未完成，IR10 整项和 IR10.4 保持不勾选。

普通聊天增量：[聊天纠错与连续版本记录](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/chat-correction-report.md)。IR08.1 已在 enforce V2 普通消息路径接同一纠错事务，原事件复用、歧义定位提示、共享两次预算、连续版本规范目标、旧 follow-up 防复活和 Session ledger 缓存防倒退已实现。全仓 2890 通过/21 PostgreSQL 跳过，最终增量相关回归 250 通过，真实 localhost HTTP 7 项通过；报告分别注明各次源码范围。所有首轮/特殊消息分支统一、执行型纠错、结构化目标澄清、真实双客户端及数据库验证仍待完成，IR08/IR10 整项不勾选。

新语义分类增量：[持久化提案与单层修复预算](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/semantic-proposal-report.md)。IR03.3/IR04/IR06 基础增加独立新合同分类状态机、跨实例租约、反馈恢复和绝对 deadline；旧 worker 拒绝新提案。实际 Runtime 发现并修复 Generic LLM 与分类器双层格式修复，已有纠错也补齐反馈恢复。Server 2000 + 开发脚本 7 通过/21 PostgreSQL 跳过，相关 155 通过，Runtime 4 项和聊天 HTTP 7 项通过。新分类服务尚未接 Sessions 首轮/普通入口，IR06.1 及完整 G2 不勾选，下一步为计划编译提交及延后 WorkItem/Brief 创建。

新 Sessions 入口增量见[开发记录](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/semantic-ingress-report.md)：显式 cohort 的首轮/普通消息已接持久化新合同，合法计划之后创建任务上下文或自动纯回答；重启与关闭开关保留会话合同。Server 2033 + 7、最终相关 22、真实 API 7 项通过，21 PostgreSQL 跳过。新合同纠错、受控 Brief/业务执行器及全部特殊入口仍待实施，IR06/G2 不勾选。

新合同聊天纠错增量见[记录](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/semantic-correction-report.md)：新提案在接收事务重编译、唯一目标与版本核验后复用原纠错状态机，保留原事件、不创建旧 follow-up，初次识别和复核共享两次预算。相关 87 项、实际 HTTP 11 项通过；连续版本、伪造目标、CAS 和写盘回滚有证据。执行型纠错、结构化澄清、特殊入口与完整 IR06/IR08/G2/G3 仍未完成。

工作区读取增量见[只读回答记录](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/workspace-answer-report.md)：显式 server_local 绑定签发独立只读 grant；编译、逐次工具调用和结果发布重验 scope/版本，Generic LLM 实际执行只读文件和字面搜索。全仓 2949 通过/21 PostgreSQL 跳过，最终字面搜索增量 85 项和真实文件 HTTP WR01–WR05 通过。GitHub 默认来源、本地 Bridge、权限撤销 UI/API、测试/源码/产物执行器及完整 IR05/IR06 仍未完成。

授权与源码就绪增量见[开发记录](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/workspace-authority-report.md)：已实现撤销/重新授权 CAS API、审计及缓存保护；源码未就绪零分类，完成后事务绑定并调度原消息。真实 HTTP 8 项通过，包括读取前/回复发布前撤销及新授权不复活旧计划。前文“撤销 API/源码就绪未实现”为历史状态；授权 UI、真实 GitHub 全链、本机读取及完整 IR05/IR06 仍未完成。

读取授权界面增量见[报告](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/workspace-authority-ui-report.md)：Web/Desktop 接入共享面板，冻结重试身份，版本冲突刷新并等待用户操作；11 项新增测试、Web 481 项、后端相关 168 项及 HTTP 8 项通过。共享组件已完成真实浏览器+隔离 API 验证；完整双端/Electron/SSE 故障矩阵仍未完成，IR10 不整体勾选。

隔离测试基础增量见[记录](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/isolated-tests-report.md)：TestRunnerTool 可使用固定镜像的无网络容器、只读源码快照及 scratch；真实容器验证源码/凭据/网络隔离和超时子进程停止。新合同自动派发尚未接授权、版本与恢复对账，IR05.1–IR05.3 保持未完成。

隔离执行恢复增量见[记录](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/isolated-tests-recovery-report.md)：LogicalOperation 已保存容器/daemon/快照/租约/结果，实际 Runtime 测试适配器传递服务端身份；过期接管只对账停止、不重跑，迟到 settle 不释放未知停止。真实进程崩溃与正常结果落盘已有容器证据。前文“恢复对账未接”为历史范围；grant/runner 绑定、版本计划派发、硬删除记录保留和完整多实例/数据库验证仍待完成，IR05/IR09 不整体勾选。

测试授权增量见[记录](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/test-authority-report.md)：独立测试授权 API、固定 runner 资源绑定、快照候选、Session 缓存保护及执行前 grant 版本门已实现，241 项相关回归与实际 HTTP 8 项通过。前述 grant/runner 绑定未接为历史状态；授权 UI、版本计划派发、实际效果和运行中撤销尚未闭环，IR05/IR06/IR09 仍只部分完成。

测试授权界面增量见[记录](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/test-authority-ui-report.md)：两端接入共享面板，支持脚本选择、撤销、冲突刷新及当前标签页刷新后的原请求重试。最终新增 12 项与 Web 全量 493 项通过，实际浏览器+API 8 项通过；完整 Electron/SSE 与测试派发尚未验收，IR05/IR10 不整体勾选。

测试启动绑定增量见[记录](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/test-runner-binding-report.md)：预约、启动和续期核对实际脚本/镜像/目录及运行步骤，将绑定持久化；真实 Docker 验证指定脚本、源码不变与持久化授权撤销后的停止。API 即时取消、版本计划派发和结果发布事务尚未接通，IR05/IR09 不整体勾选。

版本化测试派发增量见[报告](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/test-dispatch-report.md)：既有任务的单测试计划已贯通 Runtime/Tool/固定 runner；独立工具能力、单次持久化调用、授权通知取消、结果事务与旧版本保护已实现。最终实际 HTTP+Docker TD01–TD07、104 项相关回归通过。执行型纠错、多段计划、其他写入效果和完整环境矩阵仍未完成，IR05/IR06/IR09 维持部分完成，不整体勾选。
