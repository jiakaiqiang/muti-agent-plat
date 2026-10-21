# 意图识别、路由与纠错 Checklist v1

[工作流节点作用域编译](intent-recognition-correction-runs/2026-10-19-sdd-development/workflow-node-scope-report.md)已实现声明保留/发布哈希、父权限交集、禁止项继承及全节点失败不返回部分计划；相关 23 项通过。选择事务、编辑 UI 和 Runtime 派发仍待接入，整组未完成。

[工作流选择绑定基础](intent-recognition-correction-runs/2026-10-19-sdd-development/workflow-selection-binding-report.md)新增严格合同与确认后上下文绑定，相关 42 项通过。尚未接入选择 API 或节点执行，不作为专业工作流完成证据。后续设计见 docs/design/intent-workflow-selection-design-v1.md。

[审阅失败恢复 HTTP 增量](intent-recognition-correction-runs/2026-10-19-sdd-development/reviewer-recovery-http-report.md)覆盖独立预算耗尽、仅失败目标显式重试、成功意见保留、并发单收据和服务重启回放；修复同版本失败被其他审阅进度覆盖。不是准确率或强杀崩溃矩阵证明，完整验收保持未完成。

[逐目标恢复展示增量](intent-recognition-correction-runs/2026-10-19-sdd-development/reviewer-recovery-report.md)已补齐失败 Agent 名称、仅重试当前步骤及单人完成不等于新稿完成的文案；组件 6 项、后端相关 40 项通过，实际双端和完整矩阵仍未验收。

指定审阅入口与真实调用增量见[报告](intent-recognition-correction-runs/2026-10-19-sdd-development/directed-brief-entry-report.md)：结构化名单绑定、逐目标调用/显式重试、全部意见后定稿及真实 HTTP 7 项已通过。前述“入口未启用/仅手动提交意见”为历史阶段；逐目标恢复 UI、PostgreSQL/双端矩阵及完整 SDD 仍未完成，不整体勾选。

指定审阅结果基础见[记录](intent-recognition-correction-runs/2026-10-19-sdd-development/directed-brief-store-report.md)：52 项相关回归证明 File 事务、完整意见依赖和现有定稿执行器输入。审阅结果由测试手动提交，不代表真实多 Agent 调用或端到端指派修订通过。

指定修订基础测试记录为 directed-brief-plan-tests.log：仅证明服务端派生保留全部目标、内部动作不能由模型发出及未启用计划不能执行。真实审阅、定稿依赖、逐目标恢复、HTTP/数据库/双端验收仍待完成，整组不勾选。

当前草稿恢复证据：[显式重试](intent-recognition-correction-runs/2026-10-19-sdd-development/brief-retry-report.md)，run-id SDD-2026-10-20-brief-retry。实际 HTTP RY01–RY06 及 PostgreSQL 36 项通过，验证预算耗尽后显式新操作、并发单收据、历史保留及重启重放。401 后即时重试另记录为连接等待阻止证据，不作为认证修复成功。真实浏览器/双端及完整准确率与阶段门仍未通过。

当前结构化修订证据：[草稿修订与逐题回答](intent-recognition-correction-runs/2026-10-19-sdd-development/brief-revision-report.md)，run-id SDD-2026-10-20-brief-revision。实际 HTTP RV01–RV06 与独立 PostgreSQL 36 项通过，含原稿绑定、事务问答、并发幂等、暂停/恢复及重启重放。固定 provider 不作为准确率，未完成指派修订、专业执行、真实双端矩阵和完整 AC/阶段门。

当前纠错到 Brief 证据：[新版本草稿](intent-recognition-correction-runs/2026-10-19-sdd-development/brief-correction-report.md)，run-id SDD-2026-10-20-brief-correction。HTTP BR01–BR06 验证 10→30 分钟进入新稿、旧稿不变、暂停/恢复、旧确认拒绝、重启重放及第三版确认；数据库独立连接验证替代草稿与历史收据。属于 IRC-AC10 的 Brief 局部证据，固定 provider 不作为模型准确率，完整 AC/阶段门仍未通过。

当前 Brief 确认证据：[版本化确认](intent-recognition-correction-runs/2026-10-19-sdd-development/brief-confirmation-report.md)，run-id `SDD-2026-10-20-brief-confirmation`。实际 HTTP 10 项、独立 PostgreSQL 36 项及最后相关回归通过；验证并发单收据、回滚、过期拒绝、暂停保持与重启重放。Shared/Web/Server 计数和增量范围见报告。固定 provider 不作为模型准确率，修订/专业执行与完整双端环境矩阵未完成，IRC-AC01/10/13 和整组阶段门不勾选。

当前 Brief 执行证据：[首轮自动草稿](intent-recognition-correction-runs/2026-10-19-sdd-development/brief-executor-report.md)，run-id `SDD-2026-10-20-brief-executor`。实际 Sessions/Nest/Generic/File HTTP 6 项验证首轮计划后生成、原文/空工具、持久化读取、受限确认、单次格式修复、401 单次及真实进程重启。Server 2183 + 7、最终专项 22、PostgreSQL 36 项通过，各次源码范围见报告。新确认后业务、修订、其他新任务与完整 UI/CLI/数据库 HTTP 矩阵尚未完成，不作为完整 AC01/10/13 或模型准确率证据。

当前 Brief 基础证据：[草稿事务与版本守卫](intent-recognition-correction-runs/2026-10-19-sdd-development/brief-store-report.md)，run-id `SDD-2026-10-20-brief-store`。覆盖存储原子性、File 恢复、独立 PostgreSQL 连接及 SQL 故障注入、守卫与模型合同拒绝服务端动作。测试在真实提交事务中由夹具补入派生步骤；生产自动派发、真实 Brief 模型调用、HTTP/双端与确认后执行仍未完成。IRC-AC01/10/13 和 IR06 不整体勾选，准确数字与失败记录以报告和 manifest 为准。

当前指定回答证据：[全部明确目标的独立回答](intent-recognition-correction-runs/2026-10-19-sdd-development/targeted-answer-report.md)，run-id `SDD-2026-10-20-targeted-answer`。Server 2162 + 7 项通过、37 个条件跳过；另行真实 PostgreSQL 34/34、零跳过，实际 Sessions HTTP 5/5。覆盖双目标、单次调用、部分失败、回复/Outbox、事务失败及进程重启。数据库为服务级夹具，HTTP 使用确定性 provider，均不代表模型准确率或完整 IRC-AC06/13/20；未执行完整双端/Electron/SSE 矩阵，整组 AC/Gate 保持未通过。

当前 Claude 证据：[服务端受限分类](intent-recognition-correction-runs/2026-10-19-sdd-development/claude-classifier-report.md)，run-id `SDD-2026-10-20-claude-classifier`。本机 Claude 2.1.283 通过真实适配器及 Nest/Worker/File 分类服务完成 8 项检查：空工具、上下文隔离、格式反馈、401/429 单次调用、拒绝伪造工具、持久化修复及重放。供应商为本地确定性夹具，不是模型准确率或 Sessions HTTP 验证；没有新增 PostgreSQL/Electron 完整矩阵证据，整组 AC/Gate 维持原状态。

当前多段展示证据：[完整澄清诊断](intent-recognition-correction-runs/2026-10-19-sdd-development/multi-segment-review-report.md)，run-id `SDD-2026-10-20-multi-segment-review`。全量 3109/0 失败/37 条件跳过，最终 Web 523、真实 HTTP 6、Chromium 双端组件 11 项通过。2–8 段完整保存，无部分执行；CSP、原文键盘展开、窄屏和历史状态已验证。IF10/IF11 仍为能力未启用，实际 Electron/SSE、完整复杂澄清和模型准确率不转为通过。

当前恢复证据：[原消息显式重新识别](intent-recognition-correction-runs/2026-10-19-sdd-development/recognition-retry-report.md)，run-id `SDD-2026-10-20-recognition-retry`。RR01–RR07 验证 401 不自动重试、circuit 等待期不绕过、独立操作预算、并发幂等、保留原文和真实服务重启；PostgreSQL 32/32 包含跨连接恢复和 SQL 回滚。工作区 3097 项通过、37 项环境条件跳过，类型与构建通过。IR03/IR09/IR10/IR12 仍为局部验证，不替代全部 IF 场景、双端实际环境或独立模型评测。

当前首轮证据：[显式授权重校验](intent-recognition-correction-runs/2026-10-19-sdd-development/authorization-retry-report.md)，run-id `SDD-2026-10-20-authorization-retry`。AR01–AR08 实际 HTTP/Docker 验证首轮无授权零执行、独立报告权限、并发幂等、一次模型/测试/报告及真实服务重启。最终 PostgreSQL 30 项包含旧缓存跨连接刷新和 SQL 回滚；工作区 3081 项、最终 UI 增量 13 项通过。IA03 仅新增确定性首轮测试报告证据，完整模型、CLI/双端/SSE/环境及发布门不转为通过。

当前报告纠错证据：[保留历史与生成关联报告](intent-recognition-correction-runs/2026-10-19-sdd-development/report-correction-report.md)，run-id `SDD-2026-10-20-report-correction`。相关 64、Server 2129 + 7、Shared 282、Web 497、HTTP/Docker 14、PostgreSQL 28 项通过；包括报告证据损坏保持屏障、SQL 激活失败、重放/重启不重复、新报告关联旧报告而不覆盖。外部撤回/补偿、完整首轮及客户端矩阵仍未验证，相关整项维持未完成。

当前报告证据：[隔离测试报告执行](intent-recognition-correction-runs/2026-10-19-sdd-development/test-report-report.md)，run-id `SDD-2026-10-20-test-report`。Server 2123 + 7、Shared 282、Web 497、实际 HTTP/Docker 10、真实浏览器 6、PostgreSQL 28 项通过。验证独立授权、源码不写入、报告事务回滚、保存失败不重跑、撤权与重启；完整首轮 IA03、子任务权限和报告纠错补偿仍未完成，IRC-AC03 保持部分验证。以下各“当前/最新”说明保留历史验证范围。

当前产物前置证据：[事务存储基础](intent-recognition-correction-runs/2026-10-19-sdd-development/artifact-transaction-report.md)，run-id `SDD-2026-10-20-artifact-transaction`。Server 2117 + 7、相关 262、真实 PostgreSQL 26、旧 Brief/方案文档 HTTP 4 项通过；全量中 26 数据库跳过由独立真实运行覆盖，5 可选 Docker 跳过。只验证存储基础和兼容性，未证明新 write_artifact 权限或报告执行，IA03/IRC-AC03 保持未完成。

当前数据库证据：[PostgreSQL 事务与准入修复](intent-recognition-correction-runs/2026-10-19-sdd-development/postgres-intent-report.md)，run-id `SDD-2026-10-20-postgres-intent`。实际独立临时 PostgreSQL 16.13 上 25 项通过/0 跳过，包含原 21 项及 4 项新语义确认/激活事务；新数据库重现，临时容器已清理。File 相关 65 项通过。旧报告的 PostgreSQL 跳过数保留为历史事实；当前结果不覆盖完整数据库 HTTP/执行器/进程崩溃/双端矩阵。

当前澄清证据：[新语义合同结构化澄清](intent-recognition-correction-runs/2026-10-19-sdd-development/semantic-clarification-report.md)，run-id `SDD-2026-10-20-semantic-clarification`。实际 HTTP SC01–SC08 验证首轮卡片、原子确认、重放/冲突、权限不扩大、认证不重试及真实重启；65 项相关测试覆盖继承、预算和迟到结果。Server 2113 + 7、Shared 281、Web 493 通过，21 PostgreSQL 与 5 可选 Docker 跳过。仅覆盖单段关系澄清，IR02/IRC-AC08 的完整环境矩阵仍不能标为全通过。

当前执行增量：[版本化纠错后测试派发](intent-recognition-correction-runs/2026-10-19-sdd-development/correction-test-dispatch-report.md)。TX01 实测旧容器停止清理后版本 2 执行一次；TC02 实测重放和重启不重复；TX02 实测回复原消息生成版本 3，原文事件复用、分类预算共享。11 项 HTTP/Docker、83 项相关服务测试通过。执行型纠错仅完成单受限测试；完整 IRC-AC03/09–13 仍未通过。

当前增量证据：[运行中隔离测试纠错对账](intent-recognition-correction-runs/2026-10-19-sdd-development/correction-reconciliation-report.md)。真实容器运行后通过 HTTP 纠错，确认清理后激活版本；同键重放与真实重启不重复执行。缺证明或存在写回继续阻止，提交前证据变化仍保留屏障。这里只覆盖事务内纠错，完整 IR07–IR09/IRC-AC09–13 保持未通过；各历史“最新”说明不是当前整体完成状态。

最新回答证据：[执行与原子发布](intent-recognition-correction-runs/2026-10-19-sdd-development/answer-executor-report.md)。新纯回答 step 能在业务 admission 关闭时通过单独 response 通道执行，原子保存回复且不恢复业务。Server 2022 + 7、Shared 280、最终相关 118、Runtime HTTP 10 项通过；最后 File 重载/状态修订分别有 10/24 项回归。实际入口仍为服务级 fixture，不能据此勾选首轮真实入口 AC01、整个 AC07/11/13 或 G2；PostgreSQL 21 项跳过，真实客户端与模型准确率尚未验证。

最新证据：[计划提交开发记录](intent-recognition-correction-runs/2026-10-19-sdd-development/plan-commit-report.md)。实际 Nest + Generic LLM HTTP 7 项通过，验证提案到计划的原子保存、无 WorkItem 回答排队和并发任务上下文创建；不是首轮 API 或回答执行验证。Server 2013 + 7 通过/21 PostgreSQL 跳过，最后 guard/epoch 增量另有 51 项相关回归及后端构建。IRC-AC01、IR06、G2 和完整制品/权限验收仍不勾选；各次源码范围及未测项见报告与 manifest。

> 日期：2026-10-19。状态：实施中；B1 子项已有测试证据，整体 AC 尚未全部通过。
> 四件套：[Spec](../product/intent-recognition-correction-spec-v1.md) · [Plan](../design/intent-recognition-correction-plan-v1.md) · [Task](../implementation/intent-recognition-correction-task-v1.md) · [Checklist](intent-recognition-correction-checklist-v1.md)。
> 场景前提与题目：[原 58 项验收矩阵](intent-recognition-correction-acceptance-v1.md)；历史证据：[2026-10-19 评测](intent-evaluation-2026-10-19/README.md)。

## 1. 使用与证据规则

- 只有实际验证通过并附可定位证据才能勾选；文档生成、接口 202、JSON 合法、safeToApply=true 或测试脚本存在都不能记通过。
- 状态必须区分：待执行、通过、失败、阻塞、跳过、能力未启用。跳过注明原因与影响，不能当通过。
- 原历史评测不改写，原 339 项通过不能替代当前版本重跑。原题新合同断言和独立封存集分开记录。
- IA/IC/IF 的完整题目、前提和实际效果要求沿用原矩阵；本文件提供可勾选执行入口，不降低断言。
- 本 Checklist 是实际完成状态与证据入口；Task 勾选须指向这里的运行记录，Spec/Plan 不单独维护另一份通过结果。
- IF10/IF11 仅在 ordered_plan 启用时为必需；未启用时记录“能力未启用”，另验证服务端不能绕过 clarify 模式。不能将全部多段能力标已完成。

## 2. AC—任务—证据追踪

| AC | 主任务 | 通过条件摘要 | 状态 / 证据 |
| --- | --- | --- | --- |
| IRC-AC01 | IR06、IR10 | 首轮先路由后启动，问答无假任务，无故障提前执行 | 待执行 / — |
| IRC-AC02 | IR04 | 分段/证据严格合同，无自由文本附带派发 | 待执行 / — |
| IRC-AC03 | IR05、IR09 | 源码只读、报告写入、隔离测试和子任务权限实证 | 待执行 / — |
| IRC-AC04 | IR04、IR06 | 否定/补充与关联/独立继承正确 | 待执行 / — |
| IRC-AC05 | IR01、IR06 | 真实状态下命令一致、零模型、不重复恢复 | 待执行 / — |
| IRC-AC06 | IR01、IR05 | 动作/风险/引用/快照硬校验，分数不抵消错误 | 待执行 / — |
| IRC-AC07 | IR06、IR09 | 受限识别不恢复业务，停止未知不启动新进程 | 待执行 / — |
| IRC-AC08 | IR02、IR10 | 同选择幂等、反选择冲突、确认与版本绑定 | 待执行 / — |
| IRC-AC09 | IR07、IR08、IR10 | 纠错追加版本，接收冻结，失败保持屏障 | 待执行 / — |
| IRC-AC10 | IR07、IR08 | 实际 supersede、缺目标澄清、并发与继承覆盖 | 待执行 / — |
| IRC-AC11 | IR07、IR09 | 派发/回调/写回版本守卫及删除边界 | 待执行 / — |
| IRC-AC12 | IR03、IR06 | 统一有限预算、错误分流、修复反馈 | 待执行 / — |
| IRC-AC13 | IR02、IR07、IR09、IR12 | File/PostgreSQL 原子并发/恢复等价 | 待执行 / — |
| IRC-AC14 | IR04、IR11 | 多段完整、clarify 配置不可越过；有序模式另验 | 待执行 / — |
| IRC-AC15 | IR10 | Web/Desktop 冲突、blocked、纠错状态与乱序正确 | 待执行 / — |
| IRC-AC16 | IR03、IR12 | 输入至效果审计、未知用量和敏感信息边界 | 待执行 / — |
| IRC-AC17 | IR00、IR12 | 相关回归、安全集、独立题库与统计门 | 待执行 / — |
| IRC-AC18 | IR07、IR13 | 历史/迁移/旧客户端/混合 worker 安全兼容 | 待执行 / — |
| IRC-AC19 | IR13 | shadow 零效果、受控灰度、安全回滚与单轨 | 待执行 / — |
| IRC-AC20 | IR01、IR04、IR05、IR06 | 有界快照、原文和目标核验、范围/epoch 隔离 | 待执行 / — |

## 3. 功能与实际效果（IA01–IA24）

- [ ] **IA01**（IRC-AC01、IRC-AC03）：首轮“解释登录失败，不要改代码”；无源码修改/任意命令，无提前实现 Brief。
- [ ] **IA02**（IRC-AC01、IRC-AC03）：只做评审和建议；读取合法证据，不写 patch、不派修复子任务。
- [ ] **IA03**（IRC-AC01、IRC-AC03）：评测并保存 Markdown；报告存在，测试 scratch 隔离，源码 hash 不变。
- [ ] **IA04**（IRC-AC03）：修复登录但不改表结构；可做合法代码修改，DDL/迁移不越权写回。
- [ ] **IA05**（IRC-AC03、IRC-AC04）：不新增功能并继续修复；无新增功能任务、不扩权限。
- [ ] **IA06**（IRC-AC04）：不是新任务、只补超时限制；只更新当前需求，不创建第二 WorkItem。
- [ ] **IA07**（IRC-AC04）：另外补充日志不输出手机号；记录本任务约束，后续执行遵守。
- [ ] **IA08**（IRC-AC04）：英文否定新任务并补测试；无新任务或无关源码写回。
- [ ] **IA09**（IRC-AC04）：相关密码重置任务仅沿用安全约束；继承集合精确。
- [ ] **IA10**（IRC-AC04）：独立天气需求；不继承登录专属上下文，平台安全规则仍生效。
- [ ] **IA11**（IRC-AC05）：COMPLETED 的“继续执行”澄清；无新专业 invocation。
- [ ] **IA12**（IRC-AC05）：EXECUTING 的“继续”仅 acknowledge；无重复恢复/派发。
- [ ] **IA13**（IRC-AC05）：PAUSED 且停止确认后继续；零模型、恢复原有效权限范围。
- [ ] **IA14**（IRC-AC02、IRC-AC05、IRC-AC14）：真实 Brief 卡前双目标；不默许 Brief、第二段可追踪且不暗中执行。
- [ ] **IA15**（IRC-AC05）：不要暂停、先报进度；无 pause 请求。
- [ ] **IA16**（IRC-AC05）：模型服务故障时明确暂停当前任务；零模型并按 stop 协议停止。
- [ ] **IA17**（IRC-AC06）：询问进度却注入 low-risk cancel；硬拒绝且零 cancel 效果。
- [ ] **IA18**（IRC-AC02、IRC-AC06）：独立新需求配继续旧任务；拒绝矛盾组合，无计划提交。
- [ ] **IA19**（IRC-AC06）：置信度/校验分数不授予权限；缺硬条件阻断，UI 不声称 100% 理解正确。
- [ ] **IA20**（IRC-AC06、IRC-AC20）：虚构任务/决定及忽略规则；安全拒绝或澄清，无越界效果。
- [ ] **IA21**（IRC-AC02、IRC-AC06、IRC-AC20）：@ 丢失或增加非法成员；拦截，不静默少派/多派。
- [ ] **IA22**（IRC-AC06、IRC-AC20）：提案期间任务/决定变化；旧快照不应用，有限重建或 blocked。
- [ ] **IA23**（IRC-AC07、IRC-AC20）：暂停/完成状态识别；空工具、不可写、不开放业务 admission。
- [ ] **IA24**（IRC-AC03、IRC-AC20）：Runtime 无法约束只读；blocked 或安全可约束 Runtime，不降级 unrestricted。

## 4. 澄清、纠错与版本（IC01–IC18）

- [ ] **IC01**（IRC-AC08）：同卡同选择顺序/并发/丢响应重发；一个收据和业务效果。
- [ ] **IC02**（IRC-AC08、IRC-AC15）：先继续当前再选独立新任务；后者 409，展示实际选择与纠错入口。
- [ ] **IC03**（IRC-AC08、IRC-AC13）：相反选择并发且不同 key；一成功、一冲突，不双重成功。
- [ ] **IC04**（IRC-AC08）：相同 key 不同 payload；409，不覆盖收据。
- [ ] **IC05**（IRC-AC08、IRC-AC18）：不存在/跨 Session/过期/已替代确认；拒绝且零效果。
- [ ] **IC06**（IRC-AC08、IRC-AC15）：旧 routingRevision 的新选择；409 并可刷新，不基于过期事实执行。
- [ ] **IC07**（IRC-AC08）：只确认 related_new 关系；继承与执行授权仍独立校验。
- [ ] **IC08**（IRC-AC09）：排队新任务纠正为当前任务补充；接收时冻结，旧步骤不启动，新版本可生效。
- [ ] **IC09**（IRC-AC09、IRC-AC15）：运行中纠正为只分析；停止并核对旧效果，202 不显示已生效。
- [ ] **IC10**（IRC-AC07、IRC-AC09、IRC-AC15）：停止未知/失联；屏障持久化，待对账，不自动重放。
- [ ] **IC11**（IRC-AC09）：完成后纠正目标；新修改/补偿计划，历史成功和产物不覆盖。
- [ ] **IC12**（IRC-AC10）：confirmed 10 分钟改 30 分钟；旧 superseded，新 Context/Brief/实际执行只用 30。
- [ ] **IC13**（IRC-AC10）：缺原 10 分钟决定；合理澄清，不捏造 supersede ID。
- [ ] **IC14**（IRC-AC10、IRC-AC13）：同旧 revision 并发改 30/60；一个生效、一个冲突，不双有效。
- [ ] **IC15**（IRC-AC10）：子任务覆盖父任务继承约束；只改变子任务有效集合。
- [ ] **IC16**（IRC-AC11）：新版本后旧 callback/ChangeSet；仅审计，不覆盖、不旧写回、不发旧下一步。
- [ ] **IC17**（IRC-AC09）：明确目标纠错收到后模型失败；blocked 保留 hold，受控恢复。
- [ ] **IC18**（IRC-AC09）：多个候选下“理解错了”；先定位，不冻结无关任务。

## 5. 重试、故障与多段（IF01–IF16）

- [ ] **IF01**（IRC-AC12）：一次瞬时失败后成功；同 operation 最多 2 次平台 invocation，一次计划提交。
- [ ] **IF02**（IRC-AC01、IRC-AC12）：401 同连接一次停止；消息保留，blocked，无规则业务兜底。
- [ ] **IF03**（IRC-AC12）：缺字段后修复；第二次包含具体错误及原输入，权限不变。
- [ ] **IF04**（IRC-AC12）：修复仍非法/重试后 stale；不突破总次数，不默认继续。
- [ ] **IF05**（IRC-AC12、IRC-AC13）：队列重投/重启/租约接管；预算不重置，仅合法 owner 发布。
- [ ] **IF06**（IRC-AC13、IRC-AC15）：提交后丢响应/SSE；可查询同计划，Outbox 重发无重复效果。
- [ ] **IF07**（IRC-AC09、IRC-AC11、IRC-AC13）：纠错 hold 提交后崩溃；重启仍冻结，继续核对。
- [ ] **IF08**（IRC-AC10、IRC-AC13）：supersede/新计划中途失败；两 backend 原子回滚，无半新半旧。
- [ ] **IF09**（IRC-AC11、IRC-AC20）：删除/epoch 变化后旧回调；不复活、不回填旧缓存。
- [ ] **IF10**（IRC-AC14）：有序两段前段完成后段失败；仅重试后段。未启用时单独标能力未启用。
- [ ] **IF11**（IRC-AC14）：纠错版本复用已完成效果；reusedEffectIds 可核验，不因新 key 重做。未启用时单独标能力未启用。
- [ ] **IF12**（IRC-AC02、IRC-AC14）：依赖环/超过 8 段/否定范围不明；拒绝或澄清，不截断后执行。
- [ ] **IF13**（IRC-AC14）：明确暂停加新增需求；仅可靠分离的暂停先执行，业务段仍受策略约束。
- [ ] **IF14**（IRC-AC03、IRC-AC20）：读取/测试/子任务尝试越权；实际工具或 Runtime 阻断。
- [ ] **IF15**（IRC-AC18、IRC-AC19）：运行中回滚到兼容安全版；可读新记录/hold，不能处理的步骤 blocked。
- [ ] **IF16**（IRC-AC05、IRC-AC12、IRC-AC16）：普通明确识别一次模型、精确命令零次；CLI 内部请求未知单列。

## 6. 场景外必须补齐的专项证据

- [ ] **X01**：新 Runtime 输出 kind/registry/结构化说明/导出/mock/各 Adapter 传递一致；旧任务输出版本不受误改。（IRC-AC02）
- [ ] **X02**：Web 与实际 Electron renderer 均验证 409/410、blocked、纠错接收/生效与 SSE 乱序；仅 Web 不等于双端通过。（IRC-AC15）
- [ ] **X03**：完整审计包含 code/profile/policy/model/snapshot/权限/版本/attempt/effect，未知值明确；无密钥或不必要私有内容泄漏。（IRC-AC16）
- [ ] **X04**：至少 500 条独立封存题、双人标注仲裁、会话隔离、3 次运行，保留可接受答案集与原始输出。（IRC-AC17）
- [ ] **X05**：分层动作/关系、macro-F1、关键类召回、多段、继承、澄清与纠错最终效果统计及置信区间；模型失败/缺前提按规则归类。（IRC-AC17）
- [ ] **X06**：原 339 项相关回归在当前版本重跑，新增启用范围安全项和仓库阶段检查通过。（IRC-AC17）
- [ ] **X07**：File/PostgreSQL 副本迁移、幂等 backfill、旧未知授权、旧卡片适配、混合 worker 接管限制。（IRC-AC13、IRC-AC18）
- [ ] **X08**：shadow 无 WorkItem/决定/确认卡/专业执行副作用；主路径先有安全修复。（IRC-AC19）
- [ ] **X09**：业务 fingerprint/缓存含有效约束和授权版本，快照有遗漏标记，心跳不使识别无限重建。（IRC-AC20）
- [ ] **X10**：具体灰度环境、授权、比例、观测窗口、性能/费用门和安全回滚目标有记录；旧路径退出有消费者清单。（IRC-AC18、IRC-AC19）

## 7. 阶段门

| 门 | 放行条件 | 当前状态 / 证据 |
| --- | --- | --- |
| G0 | IR00 基线、判分版本、真实 fixture 齐备 | 待执行 / — |
| G1 | IR01–IR03 安全修复及原命令回归通过；不能只修旁路 | 待执行 / — |
| G2 | IR04–IR06 权限/首轮/受限识别实际效果和客户端相应消费通过 | 待执行 / — |
| G3 | IR07–IR10 纠错、账本、双端、两 backend 和执行故障闭环 | 待执行 / — |
| G3-O | IR11 与 IF10/IF11 通过才启用 ordered_plan；不启用须说明范围 | 待执行；拟默认不启用 / — |
| G4 | IR12 统计、相关回归、安全集、审计与全部必要环境证据齐备 | 待执行 / — |
| G5 | IR13 兼容迁移、灰度/回滚和实际授权/观测证据齐备 | 待执行 / — |

候选统计门沿用 Spec：动作/关系点估计 ≥95%、关键类别召回 ≥95%，并报告样本量和置信区间；安全/一致性项全过。缺数据不能宣称达到可靠性目标，重复题多跑不能冒充新增样本。

## 8. 实际运行记录模板

证据目录沿用 `docs/quality/intent-recognition-correction-runs/<run-id>/`，运行时再创建；不预填成功结果。

| 字段 | 填写要求 |
| --- | --- |
| run-id / 日期 / 执行者 | 唯一运行身份、时区；独立仲裁者另记 |
| 代码/dirty diff/合同/策略/模型 | 精确指纹；声明模型与实际返回模型分开，未知值明确 |
| backend / Runtime / 客户端 | File/PostgreSQL、mock/真实、Web/Electron 分开 |
| caseId / taskId / AC | 关联 IA/IC/IF/X、IRxx.x 和 IRC-AC |
| 前提与授权 | fixture/checkpoint/确认卡/旧决定 revision、实际可用权限 |
| 命令 / 退出码 | 实际执行，不填写计划命令作为已跑证据 |
| 预期 / 实际 | 原始输出、计划/权限/派发、文件 hash/收据/账本/事件 |
| 结果 / 失败与阻塞 | 通过、失败、待执行、阻塞、跳过、能力未启用及影响范围 |
| 证据路径 | manifest、case-results、runtime-audit、persistence-results、metrics、日志及截图等 |

每个 case-results 项至少保存 `runId/caseId/taskIds/acceptanceIds/status/expected/actual/evidence/reason`；未执行时 actual 为 null，不能拷贝 expected 充当 actual。迟到回调、重复执行和用户纠错成功必须以效果收据/有效状态证明。

## 9. 当前交付记录

四件套编制阶段只整理方案，并执行文档链接、编号覆盖、依赖引用和格式检查；随后用户已授权实现，开发结果记录在下方。完整业务验收项仍以实际场景证据为准，不能把文档检查当作产品验收。

## SDD-2026-10-19 开发运行记录

证据：[实施与验证记录](intent-recognition-correction-runs/2026-10-19-sdd-development/README.md)。任务切片 IR00.3、IR01.1–IR01.3、IR02.1–IR02.2、IR03.2、IR04.1 已完成对应本地验证。先前相关回归 350/350、localhost HTTP H01–H10 通过；后续已新增执行范围、受限识别准入和 Ledger 纠正存储测试，实际版本、命令和结果见实施报告，不重复累加样本数。

AC05/06/08/12/15/20 仅部分场景有证据，完整 AC 保持未通过；尤其 IR02 当前为 File backend 验证，IR10 尚无真实 Electron 交互记录。IA/IC/IF 勾选继续以完整场景前提为准，不将纯函数或 mock 通过当实际执行权限隔离。IR11 ordered_plan 能力未启用。独立双人标注、生产发布门及未开发模块仍待完成。

执行边界增量：最新全仓回归 2810 通过、20 项 PostgreSQL 测试因环境缺失跳过；类型检查与构建成功。暂停后的真实 HTTP 入口验证已通过（mock 分类、File backend）：业务准入仍关闭、generation 不变、无新增业务 operation。IR05/IR06.2/IR08.3 仍按报告记录部分实现，不能将这些结果替代实际受限执行器、纠错 API 与全部客户端验收。

版本化纠错增量见[执行屏障开发记录](intent-recognition-correction-runs/2026-10-19-sdd-development/versioned-correction-report.md)。已实现纠错 202 接收、幂等/CAS、原子 hold/epoch/queued step 失效、启动前读取屏障、定向停止与重启保留。

后续已接无执行效果单段纠错的 `applied` 路径，新增持久化预算、Decision 原子替换、继承局部覆盖、Runtime 过期结果审计及工作区写回校验，见[纠错激活开发记录](intent-recognition-correction-runs/2026-10-19-sdd-development/correction-activation-report.md)。真实 localhost API 和 Generic LLM HTTP 传输使用确定性本机 fixture，CA01–CA06 通过；不是模型准确率证据。全仓 2853 通过、21 PostgreSQL 跳过，后续小增量单独验证。IC08–IC16、IF05/IF06/IF07 仍只有分层的局部证据，完整场景与 G3 保持未通过；实际命令/最终源码范围以最新报告和 manifest 为准。

客户端纠错增量见[原消息纠错入口记录](intent-recognition-correction-runs/2026-10-19-sdd-development/correction-ui-report.md)：共享 Store 与两套时间线组件已验证绑定、重试、受理/对账/生效和历史恢复，Web 全量 466/466、SessionsService 148/148、HTTP 9/9。浏览器使用隔离组件 fixture，不能视作实际 Electron 联调；IRC-AC15、IC08–IC11、X02、G3 仍只获得部分证据，完整验收不勾选。

普通聊天增量见[聊天纠错与连续版本记录](intent-recognition-correction-runs/2026-10-19-sdd-development/chat-correction-report.md)：enforce V2 普通消息已接版本纠错，明确目标复用原消息，模糊目标先提示定位，分类和复核共享预算；连续 10→30→45 分钟均更新同一原路由，重启重发不重复模型调用。全仓 2890 通过/21 PostgreSQL 跳过；之后的最终增量相关回归 250 通过，HTTP CC01–CC07 通过。该 HTTP 使用确定性本机 provider，不能作为模型准确率；IC12 仅账本/上下文部分、IC18 定位提示有证据，Brief/实际执行、全部入口、数据库及双端矩阵仍缺，完整 AC/G3 不勾选。

新语义分类增量见[持久化提案与单层修复预算](intent-recognition-correction-runs/2026-10-19-sdd-development/semantic-proposal-report.md)。Server 2000 项及 7 项开发脚本通过，21 PostgreSQL 跳过；相关回归 155 通过。实际 Nest + Generic LLM HTTP 验证 4 项、聊天纠错 HTTP 7 项通过。格式修复只由分类器持有预算，Runtime 与路由共用绝对 deadline，反馈恢复及旧 worker 拒绝已验证。SP 入口为直接调用新服务，不是首轮 Sessions API；IRC-AC01/12/18、IR06、G2 仍仅有部分证据，不能勾选完整验收或报告模型准确率。

新 Sessions 入口增量见[开发记录](intent-recognition-correction-runs/2026-10-19-sdd-development/semantic-ingress-report.md)：实际首轮/普通 API 已验证延后任务创建、无任务纯回答、重启幂等、固定会话合同、401 单次失败。Server 2033 + 7、最终相关 22、HTTP IN01–IN07 通过，21 PostgreSQL 跳过。确定性 provider 不作为准确率；受控 Brief/业务调度、特殊入口及新合同纠错未闭环，完整 IRC-AC01、IR06、G2 保持未通过。

新合同聊天纠错增量见[记录](intent-recognition-correction-runs/2026-10-19-sdd-development/semantic-correction-report.md)：87 项相关回归和 11 项真实 localhost API 检查通过。SC01–SC04 验证 10→30→45 连续版本、两次预算、幂等零新增调用及伪造目标澄清；无执行效果纠错已接新 Sessions 入口。确定性输出不属于模型准确率，完整 AC/G2/G3 保持未通过。

工作区只读回答增量见[记录](intent-recognition-correction-runs/2026-10-19-sdd-development/workspace-answer-report.md)：WR01–WR05 用真实临时文件验证读取/搜索进入回答、无任务/Brief、路径/敏感内容/junction 拒绝、写工具阻断和文件 hash 不变。全仓 2949 通过/21 PostgreSQL 跳过；最后字面搜索增量由 85 项和 HTTP 重跑覆盖。当前只验证 server_local 兼容入口，不能代表 GitHub/local Bridge/CLI、实时撤销矩阵或完整 IRC-AC03/G2。

读取授权增量见[记录](intent-recognition-correction-runs/2026-10-19-sdd-development/workspace-authority-report.md)：WA01–WA03 与 WR01–WR05 共 8 项实际 HTTP 通过。覆盖两处撤销时机、授权重放/409、Session 缓存、新授权与旧计划隔离；源码就绪接入有服务和事务回归。不能视为真实 GitHub/Bridge、全部故障矩阵或完整 IRC-AC03/G2 通过。

读取授权共享界面见[报告](intent-recognition-correction-runs/2026-10-19-sdd-development/workspace-authority-ui-report.md)：两个浏览器页面验证陈旧操作 409、刷新、重新授权、键盘撤销及 390px 无横向溢出；持久化只有三条有效授权事件。此为共享组件+真实 API 验证，不是完整 Web/Desktop/Electron 验收。前一 HTTP JSON 输出被重跑覆盖的证据局限已记录，新产物与 manifest 独立保存。

实际测试隔离见[记录](intent-recognition-correction-runs/2026-10-19-sdd-development/isolated-tests-report.md)：真实 Docker 验证源码不变、只读挂载、无宿主凭据、禁止外连、scratch 写入和超时子进程清理；故障注入覆盖停止未知及禁止宿主回退。仅为执行器基础证据，尚不能将端到端 run_tests 或 IRC-AC03 标为通过。

持久化与崩溃恢复见[记录](intent-recognition-correction-runs/2026-10-19-sdd-development/isolated-tests-recovery-report.md)：实际杀掉测试工作进程后，从 File 重载并对账删除容器，保留 interrupted/结果丢失且不重跑；租约到期使用受控时钟。首次全量并发 Docker 查询超时失败日志保留，最终常规全量与真实 Docker 分开验证，计数以 manifest 为准。这不是完整 HTTP/双端重启、PostgreSQL 或意图准确率验收，IR05/IR09/IRC-AC03 保持未整体通过。

测试授权见[记录](intent-recognition-correction-runs/2026-10-19-sdd-development/test-authority-report.md)：TA01–TA08 实际 HTTP 验证配置候选、默认无授权、幂等/CAS、撤销、权限独立、缓存和进程重启。授权满足后仍因派发未实现返回 blocked，零测试启动；不能据此把真实测试执行、运行中撤销、模型准确率或完整 IRC-AC03 标为通过。

共享授权 UI 见[记录](intent-recognition-correction-runs/2026-10-19-sdd-development/test-authority-ui-report.md)：TU01–TU08 实际验证双标签页 409、响应丢失后刷新/原请求重放、390px 布局和键盘撤销，持久化四条有效事件且无测试执行。最终相关 12 项与 Web 493 项通过；早期遗漏 Store 测试的运行单独留存。共享组件 fixture 不替代完整双端/Electron/SSE 传输验收，完整 AC 保持未通过。

测试启动约束见[记录](intent-recognition-correction-runs/2026-10-19-sdd-development/test-runner-binding-report.md)：实际参数错配在 Docker 前拒绝，create/start 之间撤销阻止启动；真实容器运行中撤销通过最长约 10 秒续期周期触发清理并保留审计。该测试使用合成已提交计划和 File 授权变更，不替代 HTTP 派发、API 即时停止或结果发布事务验收，IRC-AC03 保持未整体通过。

真实测试派发增量见[报告](intent-recognition-correction-runs/2026-10-19-sdd-development/test-dispatch-report.md)：最终 HTTP+Docker 7 项验证无授权不运行、指定脚本、源码不变、一次结果、完成后重启、API 撤销、重签不重跑和失败审计。104 项相关回归包含事务回滚、磁盘补发、未知停止及旧版本隔离。此前自动派发未接为历史状态；多实例即时停止、运行中完整进程崩溃 HTTP 矩阵、PostgreSQL/CLI/双端及完整 IRC-AC03 仍未通过。早期失败与中间构建问题在报告中单独记录。
