# R5：恢复语义 A、通用分段规则与提示词冻结

日期：2026-10-20。目标为 intent-understanding-v1 的识别层。本文件记录开发探索，不替换上一轮正式 `intent-codex-comparison-2026-10-20/report.md`，不产生新正式成绩。原 L01–L20、H01–H12 均为开发集；本轮未读取新留出集。

## R5-1A：依据、决定与执行顺序

依据已复核：

- [Spec IRC-R02](../product/intent-recognition-correction-spec-v1.md:60)：“模型仅提交提案，服务端形成有限动作计划。”
- [Spec IRC-R03](../product/intent-recognition-correction-spec-v1.md:61)：“既有授权可在有效范围内复用，子任务不得扩权，Runtime 不能约束时阻断。”
- [Plan D04](../design/intent-recognition-correction-plan-v1.md:82)：“validUserGrant 与阶段/工具/工作区/Runtime 能力求交并减去禁止项；传到实际 Adapter/工具/写回层”。
- [Plan 第 4 节](../design/intent-recognition-correction-plan-v1.md:90)：“完整字段、动作允许矩阵和错误码沿用系统开发设计第 4–11 节，实施不能省略其负向条件。”

原规范规定了授权来源，但未规定恢复时效果数组是否为空，详见保留的 [设计门核查](intent-codex-r5-design-gate-2026-10-20.md)。用户明确选择 A 后，先在详细设计 §6.3 PAUSED 行追加以下原文，未改编号和其它状态行：

> 单纯恢复时 requestedEffects 为空，由服务端绑定原已批准计划并复核其效果范围、授权有效性与版本；空数组本身不构成授权。恢复同时提出的新要求另成 segment，按各自原文声明效果。（2026-10-20 用户决定）

然后修改 `tests/evaluation/run-intent-codex-current.mjs`：保持 H01/H11 的 `positiveResumeApplicable`（resume + 纯编译 applicable）不变；新增 `resumeDeclaresNoEffects`，要求存在 resume 段且所有 resume 段的 requestedEffects 都为显式空数组，缺失或非数组不通过。

在任何提示词编辑和探索之前，已向用户报告判分脚本 SHA-256：

`beec4dae26002278cee6572df09d15585432e466a6ae962ff6dfd60b16fc714a`

副本保存在 `intent-codex-comparison-2026-10-20/r5-freeze/scorer-before-prompt.mjs`。没有修改题面或题目期望，也未回写历史结果。

## R5-2 / R5-3：通用规则与体积

仅改 `SemanticIntentRouterService.understand()` 中四条现有 L0 规则：

- resume 仅适用于 PAUSED；单纯恢复原计划 requestedEffects=[]，服务端仍需绑定原计划并复核权限、版本；空效果不授权。
- 恢复同时提出的新要求另成 segment，各自声明有原文证据的效果。
- EXECUTING 中延续现有计划既不是 resume，也不独立成新目标；与追加要求放在同段。
- 维持已有状态是主请求的限定语，不新建状态转换或独立片段；这是第一轮开发探索发现 H02 回退后补充的通用约束。
- R5-P1 补跑发现 L07/L16 退步后，明确已有任务的追加或延续均使用 enqueue_follow_up；EXECUTING 的延续与追加合段，没有追加时仅一段且 requestedEffects=[]，不能换成 acknowledge。缺少确认是服务端执行门槛，不改变这项语义提案，enqueue_follow_up 也不构成批准。
- 压缩 relation/contextPolicy 与限定语规则，保留真正多目标拆分、否定作用域、未知关系澄清、已有任务继承等约束。没有加入题号或题面措辞。

使用 [离线测量脚本](../../tests/evaluation/measure-intent-r5-prompt.mjs)，读取上一轮 B01 实际 envelope 和提供方请求，仅替换四条变化的规则；验证替换位置、源码与已构建 dist 内容一致：

| 指标 | 修改前 | 修改后 | 差异 |
| --- | ---: | ---: | ---: |
| L0 全部 12 条规则总字符数（UTF-16，逐条 length 求和） | 3901 | 3866 | -35 |
| 同一 B01 请求估算输入 token（JSON messages 字符数 / 4 向上取整） | 8412 | 8404 | -8 |

测量记录：`intent-codex-comparison-2026-10-20/r5-freeze/prompt-measurement.json`。B01 修改后是同请求离线重建估算，未向模型发送 B01，不是新模型用量或语义成绩。8404 仍高于配置的 6000；空工具分类路径未执行输入预算拦截的已知缺口仍存在，本轮未修复。A 候选 3641 字符 / 8347 token 保存在 `explore-a-prompt-measurement.json`，B 候选 3748 字符 / 8374 token 保存在 `prompt-measurement-b.json`。

## R5-4：验证和开发探索

已完成定向测试（semantic router + route compiler）33/33、server typecheck、server build，退出码均为 0。编译器仅运行既有测试，没有修改实现。新增测试验证实际运行时构造器收到恢复/延续分段规则且仍禁止业务效果；它不证明模型一定遵守规则，真实输出另行记录。

验证日志位于 `intent-codex-comparison-2026-10-20/r5-freeze/`：C 候选修订后重新运行的 `targeted-tests-c.log`、`typecheck-c.log`、`build-c.log` 均通过。B 候选的 `targeted-tests-final.log`、`typecheck-final.log`、`build-final.log` 仍保留。评测传输处理的既有 10 项回归也通过，见 `transport-tests.log`；测量和冻结脚本通过语法检查。

开发探索使用实际 SemanticIntentRouter、持久化分类服务、Generic LLM Runtime、本地 Codex HTTP 桥和纯路由编译器；无业务动作派发。沿用串行、0 调用熔断冷却重试限制，题集 SHA 与上一轮一致。以下结果只说明看过的开发题表现，不计正式成绩。

第一轮候选 `cec5952e…` / `b4b1d100…`，标签 `explore-r5-a-20261020-h01-h03`：H01 通过（resume、空效果），H03 通过（单个 enqueue_follow_up），H02 失败（多拆 pause 段，action、routeState、goalSegmentation 三项失败）。该轮的源码、dist、原始模型输出和体积测量均保留，未覆盖失败样本。随后补入“维持现状是限定语”的通用规则。

B 候选（源码 `a7214b47…`、dist `e03c15c5…`）原探索与补跑全部保留：`explore-r5-b-20261020-h01-h03`、`…-h10-h12`、`…-l11`、`…-l16`、`…-l06-l07`、`…-l20`。补跑前实算完整源码/dist 哈希，均与用户指定值一致；L06 通过，L07 的 action 失败（输出 clarify），L20 通过。L16 已结束且原始 acknowledge 结果未改动。B 候选补跑后的冻结证据保存在 `r5-freeze/freeze-b-supplement.json`，相应源码/dist 与报告快照也保留。

发生退步后修改同一条通用动作规则，形成 C 候选；新探索标签为 `explore-r5-c-20261020-l06-l07`、`…-l16`、`…-l20`、`…-h01-h03`、`…-h10-h12`、`…-l11`。历史列只引用上一轮 `serial-confirmed-20261020-r3` 的优化后结果，未重判历史数据；当时尚无 resumeDeclaresNoEffects 检查。

| 开发题 | 上一轮观察 | A 候选 | B 候选（含 R5-P1 补跑） |
| --- | --- | --- | --- |
| H01 | positiveResumeApplicable 失败 | 通过 | 检查通过；resume、空效果、纯编译 applicable |
| H02 | 检查通过，纯编译 blocked | action / routeState / goalSegmentation 失败 | 检查通过；一个 answer_in_chat，纯编译 blocked |
| H03 | goalSegmentation 失败 | 通过 | 检查通过；一个 enqueue_follow_up，纯编译 needs_clarification |
| H10 | 检查通过 | 未跑 | 检查通过；replan |
| H11 | positiveResumeApplicable 失败 | 未跑 | 检查通过；resume、空效果、纯编译 applicable |
| H12 | 检查通过 | 未跑 | 检查通过；record_constraint |
| L11 | 检查通过 | 未跑 | 检查通过；保留两个真实目标 |
| L16 | 检查通过 | 未跑 | action、routeState 失败；输出 acknowledge，纯编译 needs_clarification |
| L06 | 检查通过 | 未跑 | 检查通过；一个 enqueue_follow_up |
| L07 | 检查通过 | 未跑 | action 失败；输出 clarify，纯编译 needs_clarification |
| L20 | 检查通过 | 未跑 | 检查通过；correct_route，引用旧 Decision 和 revision |

H03 虽通过识别检查，纯编译仍为 needs_clarification（EFFECT_TARGET_UNRESOLVED）；H02 虽通过识别检查，纯编译仍为 blocked（INTENT_AMBIGUOUS、PROHIBITION_NOT_ENFORCEABLE）。没有把这些结果写成业务可执行。H01/H11 的纯编译 applicable 也未验证提交执行。

C 候选的独立开发探索结果如下；全部来自 C 的新样本，没有拿 A/B 的通过样本补齐。每题检查项与预先冻结判分一致。

| 开发题 | C 检查结果 | 动作 / 结构 | 纯编译结果及限制 |
| --- | --- | --- | --- |
| L06 | 通过 | 一个 enqueue_follow_up | needs_clarification：EFFECT_TARGET_UNRESOLVED |
| L07 | 通过 | enqueue_follow_up，空效果 | applicable；不代表批准或提交执行 |
| L16 | 通过 | enqueue_follow_up，空效果 | applicable；未改题目或期望 |
| L20 | 通过 | correct_route；旧 Decision、revision、原文替换绑定通过 | applicable；无纠错执行派发 |
| H01 | 通过 | resume，requestedEffects=[] | applicable；positiveResumeApplicable / resumeDeclaresNoEffects 均通过 |
| H02 | 通过 | 一个 answer_in_chat | blocked：INTENT_AMBIGUOUS / PROHIBITION_NOT_ENFORCEABLE |
| H03 | 通过 | 一个 enqueue_follow_up | needs_clarification：EFFECT_TARGET_UNRESOLVED |
| H10 | 通过 | replan | applicable；提交层仍缺执行器 |
| H11 | 通过 | resume，requestedEffects=[] | applicable；两个恢复检查均通过 |
| H12 | 通过 | record_constraint | applicable；无业务执行 |
| L11 | 通过 | enqueue_follow_up + create_independent_work_item，两个真实目标 | needs_clarification：MULTI_SEGMENT_CONFIRMATION_REQUIRED |

L16 是 B 候选中观察到的退步：对单独延续当前 EXECUTING 任务、没有追加要求的请求，模型输出一个 acknowledge 段、空效果；既定期望为 enqueue_follow_up，编译器返回 STATE_TRANSITION_INVALID。L07 则因 WAIT_USER_CONFIRM 且缺少待确认记录而选择 clarify，混淆了用户意图与执行前置条件。新增/压缩规则可能影响了这些选择，但一次采样不足以确定因果。本次按用户 R5-P1 指令修正规则、换 C 标签复验；没有改题面/期望、编译器或旧结果。不能拼接 A/B/C 样本宣称一个候选全部通过。

A 候选 3 道、B 候选含补跑 11 道、C 候选 11 道开发样本均保留。B 的 11 道中 9 道检查通过，L07/L16 失败；C 的 11 道本次检查均通过。三者共 25 个样本、25 次提供方调用，每个样本各 1 次，脚本熔断冷却重试 0 次。部分 A/B 的 CLI 调用经历 WebSocket 连接错误后在同一次调用内切换 HTTPS，原始连接事件已留存；不能描述成完全无传输问题。这些数字只描述探索记录，不是正式准确率，也不是多次采样稳定性结论。

## 最终冻结

冻结脚本 `tests/evaluation/capture-intent-r5-freeze.mjs` 已纳入全部 A/B/C 共 13 个批次，并于 C 探索完成后重新运行，全部断言通过（退出码 0）。它核验全部探索题目覆盖、题集 SHA、预先报告的判分 SHA、各次所用源码/dist 与各候选保存副本一致，最终候选实际 envelope 的 L0 总字符数与测量一致，并保存前后源码/dist 副本。编译器、范围解析器、提交层三个文件均与 B 补跑前的记录进行必选哈希断言；另检查传输重试不得发生在已有提供方调用或模型输出的样本上。离线测量还验证整个路由器源码和 dist 除这四条规则之外逐字一致。

最终证据：[freeze.json](intent-codex-comparison-2026-10-20/r5-freeze/freeze.json)，路径为 `docs/quality/intent-codex-comparison-2026-10-20/r5-freeze/freeze.json`；执行日志为同目录 `freeze-validation-c.log`。最终源码/dist 副本为 `final-semantic-router.ts` / `final-semantic-router.js`。B 补跑前后的结果与 C 结果分组保存，不覆盖旧候选证据。

| 文件 | SHA-256 |
| --- | --- |
| semantic-intent-router.service.ts（C） | `9025a2428fa8d486f735683454f7c466a8ae22eddd5bc18e2e36685fb43e2828` |
| dist semantic-intent-router.service.js（C） | `ae37404ea2212dfd525a61975f130b8d1aff45be1c74bbf2575ecb0cd691e4ab` |
| 判分 run-intent-codex-current.mjs | `beec4dae26002278cee6572df09d15585432e466a6ae962ff6dfd60b16fc714a` |

已停止模型运行并冻结当前 C 候选；未启动 R5-5 正式评测。未读取或创建监督方的新留出集。后续等待监督方复核和用户正式运行授权。

## 已知边界

新链路默认关闭，本轮没有修改开关、默认配置或 `.env`。提交层对 resume、replan、retry_failed_step、非测试 enqueue_follow_up 仍缺执行器；**纯编译 applicable 不等于提交执行成功**。提示词描述的原已批准计划绑定是设计责任，不表示本轮已经实现恢复执行器。

H02 的限制仍存在：B 候选由维持暂停的限定语推出 modify_source/run_command/run_tests 三条禁止项；C 候选本次只推出 modify_source 禁止项，但二者均因禁止项在该夹具内不可约束而 blocked。上一轮也为 blocked，这不是本次新退步。H02 在 A/B 间的翻转只有单次采样，不能确定来自规则还是波动，需另经正式稳定性评测验证。

本轮不修改编译器、效果范围解析器、提交层、执行器或工作流，不做正式评测。开发探索不能证明泛化准确率或多次采样稳定性。冻结后等待监督方新留出集及用户的下一轮正式评测授权。

## R5-5 运行前准备：监督方 V3 留出集冻结（2026-10-20）

本节是上述 C 候选冻结之后的新增记录。监督方已按用户选择 A 在设计 §6.3 EXECUTING 行追加自然语言延续说明，并在 C 冻结后创建 V3 留出集；此前“未读取新留出集、等待创建”的文字描述的是冻结时状态。当前仅按用户授权验证导入和登记文件哈希，尚未启动正式运行。C 提示词、源码和 dist 不再调整。

文件：`tests/evaluation/intent-holdout-v3-2026-10-20.mjs`。

实算 SHA-256：`801ec752ff30a9ce67012004d569017b529382cb9c2aa3574e3e1022b925c1cd`。

使用 Node 动态导入成功，退出码 0：`holdoutCases` 恰为 12 题，题号依次为 V01–V12；`budgetCase` 对象可加载，ID 为 B01；导出名称为 holdoutCases、budgetCase。本轮没有修改该留出集；以此哈希冻结，之后不得修改。

正式题集接入仅允许增加 V3 导入，以及把 --supervisor 集合拼成诊断集 20 题 + 旧 H 开发集 12 题 + V3 留出集 12 题 + 原 B01，共 45 个样本。保留旧 H 文件的 budgetCase，避免两个 B01 重复加入；V3 导出的 budgetCase 只验证可加载。

上述探索用判分 SHA `beec4dae…` 及 freeze.json 作为历史证据保留，不因接入新题集重写历史结果或重新生成探索冻结文件。

接入 V3 后，`tests/evaluation/run-intent-codex-current.mjs` 的新 SHA-256：`ca37950a03d3d2aa8d190e69318e07b51ec2ae7525618bcd396d2aecf2afe1d5`。未来三个构建必须共用这份判分脚本。

验证：`node --check` 通过；将当前脚本与冻结副本 `scorer-before-prompt.mjs` 对比，断言唯一差异恰为新增 V3 导入与 supervisor 集合拼接，两处之外逐字一致。检查项、期望、夹具和传输处理均未改动。复算 V3 文件哈希仍一致，C 源码/dist 仍分别为 `9025a242…` / `ae37404e…`，与 freeze.json 一致。仅运行导入、语法与离线差异核验，没有运行评测脚本、模型调用或完整测试/build。

运行前准备到此停止，等待用户确认额度；未启动 R5-5，不再修改留出集、判分或提示词。

## R5-5 正式运行启动记录

用户已在当前会话确认“额度够”，授权正式运行。新标签为 `r5-formal-20261020-r1`：原基线和上轮优化各跑完整45题一次，C跑完整45题三次，共225个样本；每轮分5个串行批次，每批9题。此前“未启动”的表述保留为运行前历史状态。

启动时实算原基线、上轮优化、C dist、C源码、判分、V3哈希，均与本页冻结值一致。运行器另冻结服务源码/dist、共享包和评测输入；只在批次之间切换路由dist，所有模型调用及冷却沿用原判分脚本。期间不得修改提示词、题目、期望、夹具、判分或产品代码。运行日志及恢复核验写入 `intent-codex-comparison-2026-10-20/r5-formal-20261020-r1-revision/`。

本节仅登记启动，不代表225个样本已经完成。最终覆盖、成绩、传输失败、稳定性与恢复状态以运行结束后的正式报告和原始结果为准。

## R5-5 正式运行完成记录

`r5-formal-20261020-r1` 已于 2026-10-20 20:19:58（北京时间）完成，覆盖25个串行批次、225个样本。题目、期望、夹具、判分及产品提示词均未修改。

| 集合 | 原基线 | 上轮优化 | C第1次 | C第2次 | C第3次 |
| --- | --- | --- | --- | --- | --- |
| L开发集 | 13/20 | 20/20 | 20/20 | 20/20 | 20/20 |
| H旧留出、现开发集 | 7/12 | 9/12 | 12/12 | 12/12 | 12/12 |
| V新留出集 | 4/12 | 9/12 | 11/12 | 11/12 | 11/12 |
| B01语义检查 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |

C中44题3/3通过，V02为0/3，三次均把呈现偏好归为 `session_context`，冻结期望为 `same_requirement`；本轮不改判分、不调提示词。C检查结果45/45题一致，但归一化路由结构仅26/45题一致；禁止项、效果目标、上下文策略及纯编译结果仍有波动。逐检查项退步包含V02的relation通过→失败及条件式workItemTarget检查不再执行，不能以总分改善掩盖。

全部225个样本取得有效模型输出，共226次提供方调用。基线L08首次调用超时后由产品内部重试取得输出；未追加脚本重跑，脚本熔断冷却重试0次。超时调用无usage，不把未知token用量当作0。B01实发估算为7552/8412/8404/8404/8404，均超过6000仍发送，预算拦截缺口仍在。

最终源码SHA仍为 `9025a2428fa8d486f735683454f7c466a8ae22eddd5bc18e2e36685fb43e2828`，dist已恢复为 `ae37404ea2212dfd525a61975f130b8d1aff45be1c74bbf2575ecb0cd691e4ab`。冻结文件及 `.env` 哈希复核通过；恢复证据：[restoration.json](intent-codex-comparison-2026-10-20/r5-formal-20261020-r1-revision/restoration.json)。

正式报告：[report.md](intent-codex-comparison-2026-10-20/report.md)。逐题三次结果及结构差异见同一运行revision目录的 `stability.json`，全部检查项见 `check-matrix.json`，传输、构建及统计见 `comparison.json`；历史报告保存在 `report-before-r5.md`，原始结果不覆盖。

验证：运行/报告脚本语法通过，传输定向测试10/10通过，报告生成时225样本覆盖、共同题集哈希、构建哈希、期望一致性、调用账目、冷却重试合法性及恢复断言全部通过。未重跑产品完整测试/typecheck/build；沿用C冻结时的33项定向测试与typecheck/build证据，避免改动冻结构建。

新链路仍默认关闭，resume/replan/retry_failed_step/非测试enqueue_follow_up执行器、检查点、授权资源与预算缺口未补齐；识别改善不代表业务执行验收。本次正式运行结束，不继续调参或扩展工作流，等待监督复核。
