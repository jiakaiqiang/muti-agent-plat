# 意图识别与纠错实施记录：2026-10-19

当前指定审阅基础：[结果事务与定稿依赖](directed-brief-store-report.md)。已完成持久化意见、全部目标核验、定稿等待与上下文输入；指派入口、审阅 Runtime 和逐目标恢复仍在实施。各项证据范围以报告为准。

当前草稿恢复增量：[显式重试](brief-retry-report.md)，指纹 brief-retry-manifest.json。已接有限新操作、历史预算收据、旧操作屏障和双端共享入口；HTTP 6 项与独立 PostgreSQL 36 项通过。此前“失败生成恢复未接”为历史状态，连接等待反馈、指派修订、专业执行及完整验收仍待完成。

当前结构化修订增量：[草稿修订与逐题回答](brief-revision-report.md)，指纹 brief-revision-manifest.json。无指派修订表单已接统一消息管线、事务问答和新稿重新确认，实际 HTTP 六项与 PostgreSQL 36 项通过。此前“修订未接”为历史状态；指定生成 Agent、失败生成恢复、专业执行及完整专项仍未完成。

当前纠错到 Brief 增量：[新版本草稿](brief-correction-report.md)，指纹 brief-correction-manifest.json。无效果纠错已进入草稿生成/替代/重新确认链路，实际 HTTP 六项与 PostgreSQL 36 项通过；暂停不隐式恢复，历史草稿与收据保留。完整修订表单、专业执行及全部验收门仍在实施。

当前 Brief 确认增量：[版本化草稿确认](brief-confirmation-report.md)，指纹 `brief-confirmation-manifest.json`。确认 API、共享客户端固定请求、Decision/收据/Outbox 事务、暂停保持和重启重放已接通；实际 HTTP 10 项、PostgreSQL 36 项通过。此前“确认未开放”为历史状态；修订、确认后专业执行及完整验收仍待完成。

当前 Brief 执行增量：[首轮自动草稿](brief-executor-report.md)，指纹 `brief-executor-manifest.json`。真实首轮计划、自动执行器、两次预算、存储发布与缓存保护已接通；HTTP 6 项通过。确认后业务及修订仍受版本化入口约束而未开放，完整专项保持实施中。前一事务基础的“执行器未注册”为历史状态。

当前 Brief 基础：[草稿事务与版本守卫](brief-store-report.md)，指纹 `brief-store-manifest.json`。服务端派生步骤、无工具 Runtime 边界、持久化结果和事务发布已补齐基础实现；派生步骤仍由测试夹具接入，自动执行器与确认后业务流程尚未接通。该里程碑不代表首轮 Brief 端到端完成。

当前指定回答增量：[全部明确目标的独立回答](targeted-answer-report.md)，指纹 `targeted-answer-manifest.json`。单段问题保留每个明确目标，按 Agent 原子保存独立执行记录；部分失败不被其他成功覆盖，重放和重启不重复已完成模型调用。Server 2162 + 7、HTTP 5、真实 PostgreSQL 34 项通过。完整专项、独立模型准确率和发布门仍未完成；下方各历史记录保留当时范围。

当前 Claude 增量：[服务端受限分类](claude-classifier-report.md)，指纹 `claude-classifier-manifest.json`。实际原生 CLI 与 Nest/Worker/File 分类服务 8 项检查通过；无工具、独立临时目录、共享修复预算和重放已验证。只覆盖服务端分类，Codex/Bridge、真实模型准确率与专项剩余能力仍待完成。历史记录的“当前”均以其当时范围为准。

当前多段展示增量：[完整澄清诊断](multi-segment-review-report.md)，指纹 multi-segment-review-manifest.json。完整保存并展示 2–8 段、目标、禁止项和依赖，核对当前状态而不启用部分执行。全量 3109、最终 Web 523、HTTP 6、浏览器组件 11 项通过；完整复杂澄清、真实 Electron/SSE、独立模型和发布门仍未完成。

当前恢复增量：[原消息显式重新识别](recognition-retry-report.md)，指纹 `recognition-retry-manifest.json`。失败历史与旧预算保留，新操作只由显式请求生成；原消息不重复，旧处理不能覆盖新结果。工作区 3097、真实 PostgreSQL 32、实际 HTTP 7 项通过；37 个全量环境条件项跳过，其中 32 项已在独立 PostgreSQL 运行通过。确定性机制测试不代表真实模型准确率，整个专项仍在实施中。

当前首轮授权增量：[首轮测试与显式重校验](authorization-retry-report.md)，指纹 `authorization-retry-manifest.json`。只因权限/能力受阻的原请求可在授权后显式重编译，保持原语义和预算；首次任务、步骤、版本及回执原子保存。工作区全量 3081、最终 UI 13、真实 HTTP/Docker 8、真实 PostgreSQL 30 项通过。历史“首轮尚未完成”描述按各报告范围保留；当前已补受限测试报告路径，完整 IA03 和整个专项尚未验收。

当前报告纠错：[历史效果对账与关联替代](report-correction-report.md)，指纹 `report-correction-manifest.json`。已完成报告纳入纠错影响集合，证据完整才记录保留；新报告附替代关系，旧产物不变。相关 64、Server 2129 + 7、Shared 282、Web 497、HTTP/Docker 14、PostgreSQL 28 项通过。通用产物、外部补偿、首轮及发布验收仍未完成。

当前报告执行：[隔离测试报告授权与原子发布](test-report-report.md)，指纹 `test-report-manifest.json`。双重授权绑定 runner；成功/失败报告保存至会话产物，不授予源码写入；失败恢复复用 journal。Server 2123 + 7、Shared 282、Web 497、HTTP/Docker 10、浏览器 6、PostgreSQL 28 通过。完整首轮 IA03、纠错补偿与发布验收仍未完成；下文“报告未接入”是历史状态。

当前产物前置：[事务存储与旧入口兼容](artifact-transaction-report.md)，指纹 `artifact-transaction-manifest.json`。产物创建不再整集合覆盖旧缓存，调用者等待持久化；报告执行可复用事务 helper。Server 2117 + 7、相关 262、真实 PostgreSQL 26、HTTP/服务重启 4 项通过。新报告授权/执行器尚未开启，不代表 IA03 完成。

当前数据库增量：[PostgreSQL 事务验证与错误合同修复](postgres-intent-report.md)，指纹 `postgres-intent-manifest.json`。原 21 项与新增 4 项实际数据库测试全部通过，在自动创建的新数据库重现；File 相关 65 项通过。临时容器已回收。此前数据库跳过记录作为历史事实保留，完整 PostgreSQL HTTP/执行器/故障/客户端矩阵仍未完成。

当前澄清增量：[结构化关系澄清](semantic-clarification-report.md)，指纹 `semantic-clarification-manifest.json`。新合同首轮无需伪造 WorkItem，关系卡绑定版本/快照，选择不授予执行权限；恢复及重试预算持久化，最终计划/确认/Outbox 原子提交。65 项相关、Server 2113 + 7、Shared 281、Web 493、真实 HTTP/服务重启 8 项通过。复杂澄清、其他执行效果和完整专项验收仍待完成。下方各“当前/最新”保留为历史里程碑范围。

当前执行增量：[纠错后的单测试派发](correction-test-dispatch-report.md)，指纹 `correction-test-dispatch-manifest.json`。纠错 API 与普通聊天在版本激活事务后调度受限测试，11 项实际 HTTP/Docker 和 83 项相关回归通过。下文“执行型新纠错尚未接通”属于历史范围；其他执行效果和完整验收仍待完成。

当前增量入口：[运行中隔离测试的纠错对账](correction-reconciliation-report.md)，指纹见 `correction-reconciliation-manifest.json`。实际运行的隔离测试可在清理证据齐全后激活事务内纠错，旧结果不发布，重放/重启不重复生效。执行型新纠错、写回处置、完整数据库/双端/准确率验收仍待完成。下文各“最新”均为历史里程碑，不能据此判断当前完成范围。

当前最新增量：[纯回答计划执行与原子发布](answer-executor-report.md)，指纹为 `answer-executor-manifest.json`。已提交的 answer step 已有无工具执行器、持久化预算、迟到结果拒绝和回复/Outbox 事务，计划提交后才调度；File 重载可复用保存的结果。Server 2022 + 7、Shared 280、相关 118、Runtime HTTP 10 项通过，最终状态增量另有 24 项回归；21 PostgreSQL 跳过。生产 Sessions 首轮与普通入口仍未迁移。下方“回答未执行”等段落保留为各历史里程碑范围。

当前最新增量：[新语义计划的事务提交](plan-commit-report.md)，指纹为 `plan-commit-manifest.json`。提案已能原子提交为不可变计划、step 和 Outbox；有限事务内动作可完成，回答仅排队、未执行。Server 2013 + 开发脚本 7 通过/21 PostgreSQL 跳过，最终相关回归 51、Web 事件 13、Nest/HTTP 7 项通过。Sessions 首轮与普通新合同入口仍待迁移。下文各个“最新”段落均为相应历史里程碑，当前实现边界以本报告为准；整个专项保持开发中。

状态：开发中。B1 的路由硬校验、澄清事务及错误分流已有实现和回归证据；B2 的新合同、计划编译、效果授权求交、InvocationPlan 传递和 Runtime 边界已部分实现。尚未接通新语义合同全部入口、实际受限测试和写回。未完成整个专项，未开启新语义合同生产执行，未提交或部署。

最新增量为 [版本化纠错与执行屏障](versioned-correction-report.md)：四类持久化记录、V23 additive schema、纠错 202 API、原子 hold/epoch、旧排队步骤失效、运行时预约/启动屏障、精确定向停止与重启恢复。新计划激活和迟到结果写回守卫尚待开发，当前没有 `applied` 路径。源码与验证范围见 [versioned-correction-manifest.json](versioned-correction-manifest.json)。下方原执行范围记录作为上一开发批次证据保留。

| 最新增量检查 | 结果与证据 |
| --- | --- |
| 全仓回归 | 2826 通过、0 失败、21 个 PostgreSQL 跳过；[workspace-tests-versioned-correction-final.log](workspace-tests-versioned-correction-final.log)，退出码 0 |
| 最后停止守卫增量 | 26/26；[correction-stop-regression.log](correction-stop-regression.log)。在全仓测试启动后补入；新增一项不计入上面的 2826 |
| HTTP 与真实服务重启 | 8/8；[versioned-correction-http-results.json](versioned-correction-http-results.json)，使用最后一次后端构建 |
| 类型检查 | 全工作区退出码 0；[correction-version-typecheck.log](correction-version-typecheck.log)；最后后端增量由后端构建再做 TypeScript 检查 |
| 构建 | 全工作区与最后后端增量均退出码 0；[correction-version-build.log](correction-version-build.log)、[correction-version-server-build.log](correction-version-server-build.log) |
| Harness | 退出码 0；[correction-version-harness.log](correction-version-harness.log) |

最新全仓分项：CLI 102、Shared 279、Server 1942 + 开发脚本 7、Web 445、开发监督 37、Desktop 14。初次新增集合漏入初始化清单的失败保留在 [workspace-tests-versioned-correction.log](workspace-tests-versioned-correction.log)，已修复。21 个跳过中包含新增的 PostgreSQL 独立连接纠错测试；没有将跳过记为通过。

## 基线与范围

基线 SHA、已有 dirty 文件清单及指纹见 [baseline-manifest.json](baseline-manifest.json)。保留开始前已有修改。原评测目录的报告及证据未覆盖。历史 Golden V1 保留；V2 修正 COMPLETED 继续、无目标确认和无目标拒绝三条旧预期，依据统一 CommandStateResolver，不把旧错误预期当安全标准。

本批执行边界完成后的源码/依赖锁/日志指纹见 [runtime-boundary-manifest.json](runtime-boundary-manifest.json)。该 manifest 记录本批实际检查结果，不代表生产代码已发布。

## 已验证结果

| 验证 | 结果 | 证据与范围 |
| --- | --- | --- |
| 原 15 文件基线 | 339/339 | [baseline-tests.log](baseline-tests.log) |
| 4 个缺陷的修改前复现 | 4 失败 / 12 总数 | [policy-red.log](policy-red.log)，失败不是通过 |
| 策略及澄清事务 | 39/39 | [policy-clarification.log](policy-clarification.log)，真实隔离 File Persistence |
| 更新后相关回归 | 350/350 | [b1-regression.log](b1-regression.log)，包含上述相关测试，不重复累加 |
| localhost HTTP 澄清 | 10/10 | [correction-http-results.json](correction-http-results.json)，真实 HTTP/隔离状态/mock 模型，未进行真实专业执行 |
| 新合同、计划、范围求交 | 10/10 | [semantic-contract-plan.log](semantic-contract-plan.log)，纯合同与服务逻辑，不证明实际 sandbox 隔离 |
| Shared 全集 | 276/276 | [shared-tests.log](shared-tests.log)，含新合同测试 |
| 客户端状态与事件 | 15/15 | [client-state.log](client-state.log)，Pinia/Vitest，无真实 Electron 交互证据 |
| 工作区类型检查 | 退出码 0 | [typecheck.log](typecheck.log)，Shared、CLI、Desktop、Server、Web |
| Ledger 纠正存储 | 31/31 | [decision-ledger.log](decision-ledger.log)，含原约束作废、同版本并发、继承约束局部覆盖；纠错 API 尚未接通 |
| 执行范围集成 | 69/69 | [execution-scope-integration.log](execution-scope-integration.log)，含上述 Context 用例，不独立累加 |
| 本地 Runtime 全集 | 102/102 | [local-runtime-tests.log](local-runtime-tests.log)，含实际临时目录文件变化与候选隔离；不是实际 Codex 模型沙箱证明 |
| 受限路由持久化 | 13/13 | [restricted-routing-admission.log](restricted-routing-admission.log)，独立 File 数据，包含重建、版本、归档/删除及预算 |
| 暂停/工具预算回归 | 151/151 | [pause-tool-regression.log](pause-tool-regression.log)，取消旧分类不重试；越权工具在执行前失败 |
| 新范围类型检查 | 退出码 0 | [typecheck-scope.log](typecheck-scope.log)，全部工作区 |
| 初次构建与 Harness | 均退出码 0 | [build.log](build.log)、[harness.log](harness.log)；构建有已有的依赖注释和 chunk 大小警告 |
| 最新全仓回归 | 2810 通过、0 失败、20 跳过；退出码 0 | [workspace-tests-final.log](workspace-tests-final.log)：CLI 102，Shared 279，Server 1926 + 开发脚本 7，Web 445，开发进程监督 37，Desktop 14；20 项均为未配置环境的 PostgreSQL 集成测试 |
| 最新构建 | 退出码 0 | [build-scope.log](build-scope.log)，包含本批执行范围与准入变更 |
| 暂停后的真实 HTTP 入口 | 1/1 | [restricted-routing-http-results.json](restricted-routing-http-results.json)：暂停后完成一次 mock 分类，admission 仍 closed，generation 仍 1，无新增业务 operation |

命令：

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json --test --test-force-exit <baseline-manifest.json 中的 specs>
node tests/evaluation/run-intent-correction-sdd.mjs
node tests/evaluation/run-intent-restricted-routing-sdd.mjs
node node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json --test --test-force-exit packages/shared/src/intent-understanding.spec.ts apps/server/src/modules/message-routing/route-plan-compiler.service.spec.ts apps/server/src/modules/runtime-routing/execution-scope-resolver.service.spec.ts
npm run test -w @agent-cluster/shared
npm run test -w @project/web -- src/stores/session-intent-routing.spec.ts src/stores/event-normalization.spec.ts
npm run typecheck
npm run test
npm run build
npm run test:harness
node tests/evaluation/capture-intent-sdd-manifest.mjs
```

## 行为与证据映射

- IR01.1–IR01.3：统一关系/动作/上下文硬校验；精确命令复用状态解析；取消/暂停不能由 low-risk 标签授权。提交事务重新校验 Schema、来源绑定、候选引用和状态，不信任传入 safeToApply。
- IR02.1–IR02.2：intent-clarify-v1 严格输入；卡片/Session/routing/revision/时效绑定；相同选择重放先检查持久化收据，相反选择 409；原子提交 WorkItem、follow-up、resolution、确认事件与 Outbox。File 多服务实例并发及注入提交失败回滚通过，HTTP H01–H10 通过。PostgreSQL、跨进程及后续纠错替代场景尚待验证。
- IR03.2：Schema 错误反馈携带原输出上限 8000 字符与最多 20 条具体字段错误，最多一次修复并重新策略校验。401/配置/停止未知直接 blocked，模型失败不再用可执行业务规则兜底。分类尝试及 deadline 持久化，重建不重置计数；尚需完整崩溃/实际 Runtime 证据。
- IR04/IR05 基础：intent_understanding@1.0 独立注册；严格 1–8 segment、原文证据、目标、效果/禁止和依赖；环、重复 key、未知引用、越界长度拒绝。编译有限动作，保留全部多目标并要求澄清。授权求交独立区分源码、报告、测试及外部效果。该编译器尚未成为主业务执行入口。
- IR10 部分：Web/Desktop 提交固定原 Session、卡片和 revision；稳定幂等键；409/410 后刷新；routingRevision 防倒退；BLOCKED 结束轮询。共享客户端状态测试通过，真实双端验收未完成。
- IR01 兼容守卫：明确“不改源码”不再因“修改/修复”字样授予写权限；否定新任务和普通补充不创建新需求；FAILED 的问题询问不默认恢复。此规则只用于迁移兼容，不能替代新计划的授权。
- IR05 部分：本地 Codex 从 writeMode、工具目录和本机权限共同选择 sandbox；自定义权限覆盖参数被拒绝。只读调用若改变 staging 文件，返回失败且不发布恢复候选；只读 Git 任务也使用隔离副本。effectScope/executionBinding 传到 InvocationResolver、RuntimeService 和本地 Bridge 入口并重验；Generic LLM 每次工具调用核对实际工具目录，拒绝模型伪造工具名。
- IR06.2 部分：识别调用持久化为 routing admission，限定 user_message_routing、无 task、无工具、无 workspace capabilities、writeMode=none；当前仅 Generic LLM/mock 具有受支持的工具隔离实现。停止未确认、归档、删除、epoch/generation 变化都阻断 reserve。暂停后新消息可进入分类；已被用户暂停取消的旧分类仍不自动重试。业务 admission、generation 和原预算不因识别开放。
- IR08.3 存储基础：抽出 draft 级 Decision mutation；校验旧 revision 后原子 supersede；继承约束纠正仅作本地 override，并传递原始覆盖目标。新快照排除旧约束，父任务/兄弟任务不变。还没有从普通聊天或纠错 API 调用该流程，不能声明端到端纠错已完成。

## 执行范围的当前限制

新 effectScope 当前可实际选择的范围为 Generic LLM/mock 的纯回答和匹配工作区 ID 的读取。受限测试、源码写入、文件级禁止、产物保存和外部写入尚没有完整执行器证据，带这些范围的调用必须 blocked，不能以 legacy writeMode 或 Agent Profile 补授权。Codex/Claude 的 read-only sandbox 不等价于无工具识别，受限 routing 不选择这两个 Adapter。旧主业务计划尚未全部迁移，所以不能宣称全系统已实现效果隔离。

## 返工记录

新增校验发现旧应用测试直接继承未列入允许集的产物，现补充明确候选 fixture；独立任务带旧继承的测试先断言硬拒绝，再验证清空继承后的合法请求。内部服务无 modelConfidence 时以 null 适配 Runtime Schema，不把缺分数当成授权。Schema 平台不允许 uniqueItems，去重检查改为注册表的结构校验。Schema 错误中的 missingFields 曾被通用故障文本误判为配置错误，已优先识别受控错误码并补回归。

首轮全仓测试发现两项失败，原输出保留在 workspace-tests.log：固定 1000-token 的旧工具预算测试已在首轮被当前提示词耗尽，现通过公开预算错误校准初始成本，继续断言第二次请求在发送前阻断；暂停取消分类后新增受限通道误创建重试 timer，已改为取消信号不调度旧调用，并保留原暂停行为断言。151 项相关回归已通过。

最终完整重跑 npm run test 退出码 0。Web 单测有已有组件 stub 解析和 HTML 嵌套警告；构建有依赖注释/chunk 大小警告，未将这些警告记成失败或顺带修改无关界面。H01–H10 在最新构建上重新通过。以上计数代表不同验证范围，表中重叠用例不能累加为独立意图评测样本，也不能据此报告语义准确率。

## 未完成项

IR01.4 仍需收敛旧主路径。IR04–IR06 仍需新合同普通消息主入口、新首轮流程、无 WorkItem 问答、受限测试/产物/源码执行器及写回的实际授权。IR07–IR09 已接无执行效果单段纠错激活、supersede/override、Runtime 过期结果和工作区写回准入守卫，仍需普通聊天入口、执行型纠错、效果对账、全部业务投影事务及全路径迟到回调。IR10 的纠错入口及真实双端验证未完成。IR11 ordered_plan 保持未启用。IR12–IR13 尚缺完整 58 场景、故障矩阵/PostgreSQL、独立 500+ 双人标注、迁移及灰度/回滚证据。发布与生产操作未授权。

最新增量见 [纠错激活、过期结果和写回开发记录](correction-activation-report.md) 与 `correction-activation-manifest.json`。本页前述里程碑的“尚未接 API/激活”是历史范围；最新实现与证据以该增量报告为准，不能将其部分结果升级为完整验收。

下一开发顺序：接通执行权限与受限路由准入 → 新语义首轮/后续统一入口 → 版本化纠错和迟到结果守卫 → 完整验收。以上通过项均不能替代这些待完成的验收门。

最新客户端增量：[原消息纠错入口与状态记录](correction-ui-report.md)，指纹为 `correction-ui-manifest.json`。Web/Desktop 已接共享纠错面板，按原消息恢复路由、冻结提交身份、同请求重试及冲突刷新；本页此前“纠错入口未完成”描述的是该增量前的状态。真实 Electron/双客户端/SSE 全部故障矩阵仍待验证。

最新聊天增量：[普通聊天纠错与连续版本记录](chat-correction-report.md)，指纹为 `chat-correction-manifest.json`。已接 enforce V2 普通消息的事务纠错、歧义定位提示和连续版本，验证原事件复用、共享预算、重启幂等、规范历史和缓存版本保护。全仓 2890 通过/21 PostgreSQL 跳过；之后最终相关回归 250 通过，实际 localhost HTTP 7 项通过。此前“普通聊天入口未完成”是历史范围；首轮与所有特殊入口仍未统一，完整验收门不变。

最新语义增量：[新合同分类状态机与修复预算](semantic-proposal-report.md)，指纹为 `semantic-proposal-manifest.json`。新增持久化语义提案、反馈恢复、跨实例调用限制及 Runtime 绝对 deadline；实际调用发现并修复了适配器内格式修复叠加上层重试的问题。Server 2000 + 开发脚本 7 通过，21 PostgreSQL 跳过；真实 Runtime 4 项、聊天 API 7 项通过。首轮/普通 Sessions 尚未切到新提案编译链路，不能据此宣称统一入口完成。

最新入口增量：[Sessions 新语义入口](semantic-ingress-report.md)，指纹见 semantic-ingress-manifest.json。显式 cohort 首轮/普通 API 已接新分类、计划提交与自动纯回答。前文尚未接 Sessions 的描述为历史状态；新合同业务执行/纠错与特殊入口仍待完成，完整阶段门不变。

最新纠错增量：[新合同普通消息纠错](semantic-correction-report.md)，指纹见 semantic-correction-manifest.json。新 Sessions 入口已桥接版本化纠错，连续版本、共享预算、事务回滚和幂等均有本地/真实 HTTP 证据。前一入口报告中“新合同纠错未接”现为历史状态；执行型纠错、实际业务调度与完整验收仍待完成。

最新受限执行增量：[具有只读授权的工作区回答](workspace-answer-report.md)，指纹见 workspace-answer-manifest.json。已用真实文件与 Generic LLM 工具循环验证 server_local 兼容入口；全仓 2949 通过/21 PostgreSQL 跳过，最后增量单独验证。此前“回答完全无工具”的描述是历史阶段；纯回答仍为空工具，带独立读取授权的回答仅允许文件读取/字面搜索。完整受限测试/写入执行器、所有工作区类型及验收门仍待完成。

最新授权增量：[工作区读取授权与源码就绪接入](workspace-authority-report.md)，证据指纹为 workspace-authority-manifest.json。撤销/重新授权 API、缓存防复活、源码就绪事务和原消息调度已实现；实际 HTTP 8 项通过。此前未实现 API/source-ready 是历史状态，真实 GitHub 全链、授权 UI、Bridge 读取和完整验收仍未完成。

最新界面增量：[读取授权共享界面](workspace-authority-ui-report.md)，指纹为 workspace-authority-ui-manifest.json。Web/Desktop 接入共享面板，真实浏览器组件+隔离 API 验证通过；完整双端仍待验收。注意：本轮首次重跑覆盖了前一 workspace-authority-http-results.json，旧 manifest 对该 JSON 的 hash 已失效；原日志和 manifest 保留，当前结果另存 workspace-authority-ui-http-results.json，详见报告。

最新执行基础：[隔离测试执行器](isolated-tests-report.md)，指纹为 isolated-tests-manifest.json。已取得真实 Docker 的源码/网络/凭据隔离和超时停止证据；新合同 run_tests 的授权和版本计划执行仍待接通，不等同于 IR05 全部完成。

最新恢复增量：[隔离测试持久化与崩溃恢复](isolated-tests-recovery-report.md)，指纹为 isolated-tests-recovery-manifest.json。实际 SIGKILL 工作进程后重载 File，对账旧容器并保留结果丢失/操作中断，不自动重跑；正常适配器结果先落盘再返回。首次 Docker 并发超时失败日志保留，最终拆分常规全量与真实容器验证。新合同测试授权、计划派发及完整验收仍待完成。

最新授权增量：[隔离测试授权与 runner 绑定](test-authority-report.md)，指纹为 test-authority-manifest.json。独立 CAS API、配置资源绑定、快照候选与最终 grant 版本门已实现；实际 HTTP 8 项通过，授权 UI 和测试计划派发仍待完成。该 HTTP 未运行 Docker，也不作为模型准确率证据。

最新共享界面：[测试授权 UI](test-authority-ui-report.md)，指纹为 test-authority-ui-manifest.json。两端入口、脚本选择、撤销和标签页刷新后原请求重试已接通；最终 Web 493 项、相关 12 项、真实浏览器+API 8 项通过。早期测试清单遗漏已纠正并保留范围说明；实际测试派发和完整双端验收仍未完成。

最新启动约束：[测试执行参数与授权绑定](test-runner-binding-report.md)，指纹为 test-runner-binding-manifest.json。实际脚本/镜像/目录及运行计划进入持久化校验，真实容器验证单独脚本授权、源码不变和运行中 File 授权撤销后的停止。新合同测试自动派发、API 即时取消和结果发布事务仍未接通；完整阶段门不变。

最新派发增量：[版本化测试派发](test-dispatch-report.md)，指纹为 test-dispatch-manifest.json。既有任务上的单测试计划已贯通真实 HTTP/Runtime/Docker，7 项实际检查通过；最终相关 104 项、Web 493 项、开发监督器 37 项及 Desktop 14 项通过。最初全仓命令因旧 UI 文案断言失败，后续补跑明确分开记录。执行型纠错、多段、其他写入效果及完整环境/准确率验收仍待完成。


2026-10-20：[指定审阅入口与执行](directed-brief-entry-report.md)，确定性 provider 实际 HTTP 7 项，仍是 SDD 局部增量。

[逐目标审阅恢复展示](reviewer-recovery-report.md)：API 身份与共享面板增量，未新增实际双端验证。

[审阅失败恢复 HTTP 与聚合](reviewer-recovery-http-report.md)：确定性模型和真实 API/服务重启，完整目标仍未完成。

[工作流选择版本绑定基础](workflow-selection-binding-report.md)：确认后约束版本和发布定义固定，生产入口尚未启用。

[工作流节点权限编译](workflow-node-scope-report.md)：声明与全节点范围验证增量，未开放专业派发。
