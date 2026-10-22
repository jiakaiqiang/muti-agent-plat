# 监督意见：本地 Codex 意图识别评测（2026-10-20）

对象：Codex 会话 `01a1530c…`，10:01 起的轮次「回到最初的目标，先用本地 Codex 真实模型评测当前系统的意图识别和路由，针对失败题目优化，再给出优化前后的对比报告，不要再扩展工作流功能」。

## 已做对的部分（保持）

- 范围收住了：产品改动只在 `SemanticIntentRouterService.understand()` 的提示词和 Session 状态输入，没有放宽路由编译器。
- 题集在调用前冻结、前后哈希一致；原始结果不覆盖；不只重跑失败题。
- `rubric.md` 已承认「同一组失败题调优后复测」不能证明泛化。

## 必须修正（在写最终 `report.md` 之前）

### P0-1 评测夹具和生产状态不一致，基线失败被夸大

- `tests/evaluation/run-intent-codex-current.mjs:65` 把所有非 FAILED 题的 WorkItem 状态写成 `OPEN`。
- 生产映射是 `apps/server/src/modules/sessions/sessions.service.ts:8558-8575`：
  `EXECUTING → EXECUTING`；`WAIT_USER_CONFIRM / PAUSED / INTERRUPTED / WAIT_* → WAITING_USER`。
- 证据：`baseline-d/results.json:166-178`，L16 的 Session 是 `EXECUTING`，快照里 WorkItem 却是 `OPEN`。
  模型在基线里看到「任务是 OPEN + 用户说继续」，选 `resume` 有一部分是夹具造成的。
- 影响：优化说明第 1 条「会话状态缺失导致错误 resume」以及 L16/L11 的改善幅度，在生产状态下可能没有这么大。
- 要求：
  1. 夹具改用和 `workItemStatusForSessionStatus` 相同的映射（直接复用或在脚本里照抄并注释来源）。
  2. 用新的 label，在**优化前构建**（`baseline-semantic-router.js` 换回 dist，跑完恢复并核对哈希）和**最终构建**上各完整跑一遍 20 题。
  3. 报告以修正夹具后的这组前后对比为准；旧的三轮结果保留，并标注「夹具状态与生产不一致」。

### P0-2 报告必须写清楚：被测和被优化的是默认关闭的新链路

- `understand()` 只在会话 `intentContractVersion === 'intent-understanding-v1'` 时使用（`sessions.service.ts:2383`），
  这个版本只在 `INTENT_UNDERSTANDING_ENABLED=true` 且 `INTENT_ROUTING_MODE` 为 enforce 时于建会话写入（`sessions.service.ts:2025-2030`）。
- 本地 `.env` 没有任何 `INTENT_*` 配置，默认 `shadow`；评测脚本自己也设了 `INTENT_UNDERSTANDING_ENABLED:'false'`，然后直接调用服务绕过开关。
- 要求：报告开头写明「本次优化对默认配置下的线上消息路由不生效，需开启两个开关」。**不要**为此去改默认配置或开启开关（这属于扩展范围）。

### P1-1 判分要按检查项统计退步，不能只看整题

- `round1-comparison.json` 中 `regressed: []`，但 `routeReferencesAndRelation` 是 18→17、`applicable` 是 6→5；
  L20 从「只错动作名、约束绑定正确」变成「动作 + correctionBinding + routeReferencesAndRelation 三项都错」——整题本来就失败，所以被 `regressed` 漏掉了。
- 要求：报告增加「逐检查项 × 前/后」对比表，单列「题内退步」。

### P1-2 补一组调参过程中没见过的留出题，并包含反例

两轮提示词都是看着这 20 题调的，而且规则里直接写进了题面措辞
（`not a new task, do not create a task, and do not stop` 对应 L06/L07/L16，`you misunderstood` 对应 L15）。
另外新规则整体往 clarify 倾斜（needs_clarification 10→12），但 20 题里**没有任何一题的期望是正向 resume**，测不出过度澄清。

- 要求：新写 10–12 题留出集，期望在调用前冻结，覆盖同样几类问题的**不同说法**，并至少包含：
  - PAUSED 会话里的自然语言恢复（例如「好，接着把暂停的登录任务做完」），期望 `resume`，不能变成 clarify；
  - 真正需要拆开的两个独立目标；
  - 真正替换旧约束的另一种说法；
  - 带否定限定语但应当新建任务的句子。
- 在优化前构建和最终构建上各跑一遍，报告里和诊断集分开展示。
- **停止在这 20 题上继续调提示词**，不要再开第三轮。

### P2-1 量化新增规则对 6000 输入 token 预算的影响

- `understand()` 的预算是 `maxInputTokens: 6_000`。
- **更正（2026-10-20，Codex 核实、监督方复核）**：`generic-llm-runtime.service.ts:925` 的拒绝只在
  `runWithToolLoop` 内（`:338-343`，仅 `toolCatalog.tools.length > 0` 时进入）。分类调用工具目录为空，不经过此检查，
  超预算不会被拒而是照样发出（Codex 实测优化前大会话估算 7552 > 6000 仍到达提供方）。
  因此本项风险从「被拒」改为「预算声明未执行」，报告按此口径记录，不在本轮修复。
- 本轮在 L0 加了约 3–4 千字符的英文规则；评测夹具只有 1–2 条 Decision、几乎没有历史消息，测不到上限。
- 要求：报告给出每题估算输入 token（前/后）；补一题大会话夹具（correction candidates 满 8 个、多条 Decision、recentRelevantMessages 达上限），确认不会因预算被拒。

### P2-2 在报告里记录一个已知生产缺口（只记录，不修）

- 编译器要求 `recoverableCheckpointId` 才允许 `retry_failed_step`（`route-plan-compiler.service.ts:90-92`），
  但生产唯一提交入口 `intent-plan-commit.service.ts:132` 调用 `compileIntentRoutePlan` 时没有传这个参数，新链路里失败后重试在生产中永远会被拒。
- 提示词却告诉模型「有服务端失败检查点时可用 `retry_failed_step`」，与编译器口径不一致。L09 期望 `clarify` 正是建立在这个现状上。
- 用户要求不扩展工作流，所以只在报告「未解决问题」里列出，不要接线修复。

### P2-3（额度允许时）单次采样的稳定性

每题每个构建只跑了一次，13→17→20 的差异只涉及少数题。如额度允许，最终构建再完整跑一次，报告逐题是否稳定。不得拿重跑结果拼接成绩。

## 完成标准

`report.md` 同时包含：修正夹具后的前后完整对比、留出集前后对比、逐检查项退步表、适用范围声明（默认关闭的新链路）、token 预算数据、已知缺口列表。

---

# 第二轮复核（2026-10-20 11:30，针对 11:23 生成的 report.md）

## 已达标

- P0-1：夹具调用 `SessionsService.workItemStatusForSessionStatus()` 并逐题断言快照状态；构建切换有哈希校验与 finally 恢复，`restoration.json` 确认已恢复。
- P0-2：报告开头写明新链路默认关闭、本次优化对默认线上路由不生效。
- P1-1：逐检查项 × 前后表和「题内退步」已加入；旧 13→17→20 已撤回为最终结论。
- P1-2：12 道留出题在跑前冻结，含 PAUSED→resume 正例与 PAUSED 只提问的反例；本轮未改产品提示词。
- P2-1：Codex 纠正了监督方的错误判断（预算拦截只在工具循环里），并实测 7552 → 8412 token 超过 6000 仍发出，已按正确口径写入。
- P2-2：重试检查点缺口已记录，未修代码。
- 报告诚实标注「评测受阻」，没有用旧成绩或单题补跑填补缺失。

## 仍需修正

### R2-1 报告漏了一个更大的生产缺口：新链路提交层对多数动作没有执行器（只改文档）

- `intent-plan-commit.service.ts:145-146`：编译为 `applicable` 的计划，只要动作不在
  `localActions`（create_* / record_information / record_constraint）、不是 `answer_in_chat`、也不是隔离测试步骤，
  一律 `blockPlan(..., 'INTENT_ACTION_EXECUTOR_UNAVAILABLE')`，`blockPlan` 把 outcome 改成 `blocked`（`:326-329`）。
- 受影响的动作：`resume`、`replan`、`retry_failed_step`、非测试范围的 `enqueue_follow_up`。全仓没有其他兜底，也没有 spec 覆盖这条拦截。
  精确命令（「继续」「重试」等）在 `sessions.service.ts:2383` 绕过新链路，不受影响；受影响的是自然语言表达。
- 因此报告第 395 行「不等价于生产中所有已授权任务均无法恢复」不准确：即便有授权，自然语言 resume 在新链路提交层也会被拦。
  同理，L01/L06/L08/L14/L16、H03 这类「补充需求 → enqueue_follow_up」和 L10/H10 的 replan，识别正确也无法在新链路执行。
- 要求：改写第 395 行，并在「已知缺口」加一条，写清楚「识别正确 ≠ 新链路可执行」以及受影响动作清单。只记录，不接执行器。

### R2-2 结果概览表的「差异」列有误导

优化后有效输出仅 3/20、0/12，`-7 题`、`-6 题` 会被读成提示词退化。要求把差异列改为「无效（连接受阻）」，或删掉该列，只保留文字说明。

### R2-3 重跑前先修评测脚本的传输处理（只改 tests/evaluation）

本轮失败的直接原因：4 批并发调用本地 Codex，触发 429/超时；每个子进程内熔断器打开后，同批后续题约 110ms 直接返回、0 次模型调用
（优化后 26/33 题如此，优化前 4 题）。`runtime.service.ts:390-395` 的熔断返回带 `retryAfterMs`。

- 改为串行（并发 1）。
- 某题返回 `INTENT_PROVIDER_CIRCUIT_OPEN` 且 `providerCalls === 0` 时，按 `retryAfterMs` 等待后在同一次运行内重跑该题；
  这类题没有任何模型输出，重跑不算拼接语义成绩，但次数和等待时间要写入结果。
- 拿到过模型输出的题（包括输出错误或结构失败）不得重跑。
- 两个构建用同一套传输处理。

### R2-4 重跑时机由用户决定（仍有效，见下方第三轮）

周额度已用 92% 且无付费余额。完整重跑两构建 66 个样本可能中途耗尽额度，得到第三份无效结果。
在用户确认（例如等周额度重置）之前，不要启动重跑。

---

# 第三轮复核（2026-10-20 13:10，针对 13:04–13:06 的修正）

## 已达标

- R2-1：`report.md:395` 已改写为「动作识别 / 纯编译 / 提交执行」三层区分；`:447` 新增「识别正确 ≠ 新链路可执行」缺口，列出受影响动作和题号，注明精确命令不受影响。
- R2-2：结果概览差异列已改为「无效（连接受阻）」。
- R2-3：新增 `intent-evaluation-transport.mjs`。批次经 `runSerial` 串行；每题经 `withCircuitCooldown` 包裹，
  只有「熔断 + 0 次提供方调用 + 无模型输出」才按 `retryAfterMs` 等待并重建夹具重试，最多 3 次；
  缺 `retryAfterMs` 不臆造等待；已调用提供方或有任何模型输出的题不重跑。等待前落盘 `transport-<题号>.json`。
  `run-intent-supervisor-2026-10-20.mjs` 现在必须带新的 `--run-label`，不会覆盖历史证据。
- 本轮补丁只涉及 `tests/evaluation/` 下 5 个文件，没有改产品代码，没有启动重跑。

## 未独立验证

- `intent-evaluation-transport.spec.mjs` 的 10 项测试与语法检查由 Codex 报告通过；监督方 shell 被安全分类器拦截，未能自行复跑，结论来自代码审读。

## 剩余门槛

只剩 R2-4：等用户确认额度后，用新的 run-label 在两个构建上完整重跑 20+12 题和 B01，重跑期间不得修改提示词、题目或期望。
重跑完成后监督方需核对：两构建有效语义输出覆盖率是否足以比较（建议每集合 ≥ 90%）、transport 重试记录是否只出现在 0 调用的熔断题上、恢复后 dist 哈希是否回到 `5d3586dc…`。

---

# 第四轮复核（2026-10-20 15:20，针对 run-label `serial-confirmed-20261020-r3`，13:48–14:12）

## 三项验收门槛：全部通过

| 门槛 | 结果 | 证据 |
|---|---|---|
| 有效语义输出覆盖率 ≥ 90% | 两构建各 33/33（100%） | report 概览表；67 次提供方调用 / 66 样本 |
| 冷却重试只出现在 0 调用熔断题 | 0 次冷却重试，0 次 429，0 次超时 | `final-validation.json` `cooldownRetries: 0`；唯一多出的 1 次调用是基线 L13 首次 CLI 150s 超时后由产品内部重试成功，非脚本重跑 |
| dist 恢复到 `5d3586dc…` | 已恢复 | `restoration.json`；源码哈希 `8abc792a…` 未变 |

另外核对：`configuration-freeze.json` 中 `.env` 无任何 INTENT 设置；题集哈希 `3d8dd5d3…` 与上一轮冻结一致。

## 结果（单次采样）

| 集合 | 优化前 | 优化后 | 说明 |
|---|---:|---:|---|
| 诊断集 20 题 | 13/20 | 20/20 | 参与过调参，只能证明「修好了看过的题」 |
| 留出集 12 题 | 6/12 | 9/12 | 未参与调参，是本轮最有说服力的证据：H02、H07、H09 由失败转通过，无题由通过转失败 |
| B01 大会话 | 1/1 | 1/1 | 通过不代表预算安全（8412 > 6000 仍发出） |

逐检查项无退步。夹具修正后基线失败题（L07/L09/L11/L15/L16/L17/L20）与旧夹具相同，监督方 P0-1 担心的「基线被夹具压低」在本轮数据中未体现。

## 监督方抽查原始数据

`serial-confirmed-20261020-r3-after-3/transport-H01.json`：优化后模型输出 `suggestedAction: resume`、`missingFields: []`、
但同时请求 `modify_source` 且 `target.refId: null`，编译为 `needs_clarification`。与报告「识别为 resume，但请求的 modify_source 没有可解析资源」一致。

## 遗留问题（本轮范围外，供用户决策）

1. H01/H11：模型对 resume 附带未解析的 `modify_source` 效果。这是提示词层面可继续优化的点，但再调就是在留出集上调参，留出集随之失效，需要新写一组留出题。
2. H03：「照常推进，顺带补齐报错」被拆成两个 enqueue_follow_up，期望是一个。
3. 生产不可执行：新链路提交层对 resume/replan/retry_failed_step/非测试 enqueue_follow_up 无执行器；新链路默认关闭；空工具分类路径不执行输入预算。
4. 只有单次采样，无稳定性数据。

## 监督结论

本次「用本地 Codex 真实模型评测 → 针对失败题优化 → 给出前后对比」的任务已完成，报告口径诚实、证据可复核。
监督方不再要求 Codex 做进一步修改。是否继续（遗留 1–4）由用户决定。

---

# 第五轮要求（2026-10-20，用户选定方案 A：以 intent-understanding-v1 新链路为目标架构）

## 本轮范围

只做「识别本身」：H01/H11、H03 的识别问题，以及前后对比的稳定性。
**不做**：补执行器（IR09/IR11）、统一入口（IR06）、打开开关或灰度（IR13）、运行时预算拦截。这些是新链路上线的阻塞，需用户单独放行；用户 10:01 的「不要再扩展工作流」仍然有效。
**不改**：路由编译器、`execution-scope-resolver.service.ts`、提交层、默认配置、`.env`。

## 题集分工（防止再在评测题上调参）

- 原 20 题 L01–L20 + 原 12 题 H01–H12：本轮起都是**开发集**，可以看、可以针对它调。
- **新留出集由监督方写**，在你冻结提示词并报告源码哈希**之后**才创建，你在冻结前不可能看到。
  文件将放在 `tests/evaluation/intent-holdout-v3-2026-10-20.mjs`，导出格式与 `holdoutCases` 相同。

## R5-1 H01/H11：resume 附带未解析的 modify_source

现象（`serial-confirmed-20261020-r3-after-3/transport-H01.json`）：模型选对 `resume`，但同时请求 `modify_source`、`target.refId: null`。
`execution-scope-resolver.service.ts:27-31` 对非 answer 效果要求目标在服务端 `policy.resources` 内，否则 `EFFECT_TARGET_UNRESOLVED`。

先回答一个设计问题，再动提示词：**按现有 Spec/Plan，resume 是「继续原已批准的执行」（不声明新效果，授权来自原计划），还是「本次重新声明效果并重新授权」？**
- 在 `docs/product/intent-recognition-correction-spec-v1.md` 与 `docs/design/intent-recognition-correction-plan-v1.md` 里找依据并引用原文。
- 若 Spec 规定 resume 不声明新效果：在提示词里写明这一点（通用规则，不写题面措辞）。
- 若 Spec 规定要重新声明：那么 H01/H11 的 `positiveResumeApplicable` 期望在当前夹具下不可达（夹具资源为空），要改的是判分口径并在报告里说明，不是提示词。
- 若 Spec 没写清：停下来，在报告里列出两种解释和影响，不要自己选。

## R5-2 H03：「照常推进 + 顺带补一项」被拆成两段

期望是一个 `enqueue_follow_up`。对 EXECUTING 会话，「继续/照常推进」本身不是一个新目标。
已有规则「Continuing an EXECUTING task does not mean resume」只说了不是 resume，没说不单独成段。可以补一句通用规则。

## R5-3 提示词体积

上一轮新增规则让每次调用多了约 860 token（`report.md` 预算表），且空工具路径不执行 6000 预算。
本轮**净增不得为正**：新增规则要靠合并/改写已有规则抵消。报告给出改前改后 L0 规则总字符数与 B01 估算 token。

## R5-4 冻结与验证顺序

1. 只用开发集做探索调参。探索运行用独立 run-label（如 `explore-r5-*`），只跑相关题（H01/H11/H03 + 受影响的 L/H 题），**不计成绩**。
2. 跑 `semantic-intent-router.service.spec.ts` 等定向单测、server typecheck、server build。
3. 冻结：报告 `semantic-intent-router.service.ts` 源码哈希与 dist 哈希，然后**停下来等**，不要开始正式评测。
4. 监督方写入新留出集后，由用户确认额度再启动正式运行。

## R5-5 正式运行（等用户确认额度后才做）

- 三个构建：`88d1b375…`（原基线）、`5d3586dc…`（上一轮最终）、本轮新构建。
- 题集：开发集 32 题 + 新留出集 + B01。
- 新构建跑 **3 次**，另两个构建各 1 次；报告逐题 3 次是否一致，给出每题通过次数。
- 沿用串行与熔断冷却处理；不同 run-label；结束后 dist 恢复到本轮新构建并核验哈希。
- 报告把三组分开：开发集（可调参，只说明修好了看过的题）、旧 H 集（本轮已降为开发集，单列）、新留出集（唯一可信的泛化证据）。

## 完成标准

R5-1 的设计依据有原文引用；H01/H11/H03 在开发集上的变化有记录；提示词净增 ≤ 0；冻结哈希已报告；正式运行等待用户确认。

---

# 第五轮补充：R5-1 设计门结论（2026-10-20）

## 复核

`docs/quality/intent-codex-r5-design-gate-2026-10-20.md` 的引用已逐条核对原文，一致：
Spec IRC-R03（`intent-recognition-correction-spec-v1.md:61`）、详细设计 §5.3（`…system-development-design-v1.md:245`）、§6.3 状态矩阵（同文件 `:331`）。
结论「授权来源已规定，requestedEffects 是否为空未规定」成立。按 R5-1 停下是对的。

## 决定：采用 A（单纯恢复不声明新效果）

理由：
1. 快照里没有原计划的效果清单，模型要「重述效果」只能猜；H01 输出的 `modify_source` + `refId: null` 就是猜出来的。
2. IRC-R02：「模型仅提交提案，服务端形成有限动作计划」——原计划由服务端持有，绑定它是服务端的职责。
3. §6.2 要求效果有原文依据；「恢复登录模块的工作」这句话本身并不支撑任何具体效果。

## R5-1A 要做的

1. **设计文档补一句**（不改编号、不重写别的行）：在 `intent-recognition-correction-system-development-design-v1.md` §6.3 表格 PAUSED 行的「其它约束」末尾追加：
   「单纯恢复时 requestedEffects 为空，由服务端绑定原已批准计划并复核其效果范围、授权有效性与版本；空数组本身不构成授权。恢复同时提出的新要求另成 segment，按各自原文声明效果。（2026-10-20 用户决定）」
2. **提示词**：写成通用规则——resume / 单纯继续原计划不声明 requestedEffects；附带的新要求另成 segment。不得出现题面措辞。
3. **判分**：H01/H11 的 `positiveResumeApplicable` 保持「resume + 纯编译 applicable」不变（requestedEffects 为空时，编译器在 PAUSED + stopConfirmed 下可达 applicable，见 `route-plan-compiler.service.ts:87-95`）。新增检查 `resumeDeclaresNoEffects`：resume 段的 requestedEffects 为空。报告仍须注明纯编译 applicable ≠ 提交层可执行。
4. 判分改动必须在任何探索运行**之前**写入并报告哈希。

然后按原 R5-2 → R5-4 继续，H03 规则与 R5-3 提示词净增 ≤ 0 不变。冻结哈希后停下等待，不开始正式评测。

---

# 第五轮进度复核（2026-10-20，针对 `intent-codex-r5-freeze-2026-10-20.md` 与 explore-r5-a/b）

状态：**进行中，未冻结**。L16 仍在运行，`r5-freeze/freeze.json` 尚未生成，报告里还没有最终冻结哈希。

## 已达标

- R5-1A：§6.3 PAUSED 行只追加了约定原文，其它行和编号未动。判分改动（`resumeDeclaresNoEffects`）在提示词修改前冻结，SHA `beec4dae…` 有副本，`capture-intent-r5-freeze.mjs` 会断言它没变。
- R5-2：H03 在最终候选上合成一个 enqueue_follow_up；新规则是通用措辞，没有用题面原句。
- R5-3：L0 3901→3748（-153），B01 8412→8374，净增为负。
- 过程诚实：第一轮候选 A 的 H02 退步（多拆出 pause 段）原样保留，没有覆盖；补规则后换新标签重跑，没有拼接两次结果。
- 冻结脚本会断言编译器、范围解析器、提交层三个文件的哈希和上一轮一致，题集哈希也没变。

## 必须补（冻结前）

### R5-P1 补跑被压缩规则直接影响的开发题

这一轮删掉了旧规则原文 `not a new task, do not create a task, and do not stop … Keep these in that same segment`，以及 `Preserve multiple explicit goals as separate segments`。这些规则原本对应 L06/L07/L16（第一轮复核 P1-2 有记录）。目前最终候选只跑了 L11、L16，**L06、L07 没跑**。
- 要求：用最终候选（`a7214b47…` / `e03c15c5…`）跑 L06、L07，标签 `explore-r5-b-20261020-l06-l07`，加入 `capture-intent-r5-freeze.mjs` 的 batches。
- 建议额度允许时再加 L20：relation/contextPolicy/ask_user 那条也被压缩了，L20 上一轮在 routeReferencesAndRelation 出现过题内退步。
- 如有任一退步，按「改规则 → 新标签 → 不覆盖」处理，并在报告里列出。

### R5-P2 冻结报告补哈希

capture 脚本通过后，在报告里写明最终源码哈希、dist 哈希和 `freeze.json` 路径，然后停下。

## 记录（不要求本轮处理）

- H02 在 A/B 两次之间的翻转只有单次采样，分不清是规则效果还是采样波动，由 R5-5 的 3 次运行判断。
- H02 的模型从「仍然保持暂停」推出 modify_source/run_command/run_tests 三条禁止项，导致纯编译 `PROHIBITION_NOT_ENFORCEABLE` → blocked。上一轮也是 blocked，不是本轮退步，但判分只看识别层，这个现象应在已知缺口里保留。

## 未独立验证

监督方 shell 本次被安全分类器拦截，源码/dist 当前哈希、测试与构建日志是否对应最终候选，均未自行复算，结论来自日志和 capture 脚本的断言逻辑。capture 脚本跑通即可覆盖这部分核对。

---

# 第五轮冻结复核（2026-10-20，C 候选 `9025a242…` / `ae37404e…`）

## R5-P1 / R5-P2：达标

- B 候选补跑 L06/L07/L20：L06、L20 通过，**L07 退步**（WAIT_USER_CONFIRM 下输出 clarify）。加上已知的 L16，B 共 2 题退步，原样保留在 `freeze-b-supplement.json`。补跑指令要求的就是暴露这类问题。
- 处理方式合规：改同一条通用规则形成 C，换 `explore-r5-c-*` 标签，11 题全部用 C 的新样本重跑，没有拼接 A/B 结果。
- C 的 11 题检查全部通过；体积 L0 3901→3866（-35），B01 8412→8404，净增仍为负。
- C 的定向单测 33/33，typecheck、build 日志无错误。`freeze-validation-c.log` 里的哈希与报告一致，冻结脚本覆盖了 13 个批次，并断言三个受保护文件没变。
- 已停止，没有读取或创建新留出集，没有启动 R5-5。

## 需要用户决定：C 规则与设计 §6.3 EXECUTING 行措辞冲突

C 新规则写的是：`In EXECUTING, continuation uses enqueue_follow_up, not resume/acknowledge … alone emit one segment with requestedEffects=[]`。
设计 §6.3 的 EXECUTING 行写的是：「继续」→ `acknowledge`；其它约束：「不重复派发」。

现有代码其实支持 C 的做法：编译器 `route-plan-compiler.service.ts:84-86` 只允许精确命令走 `acknowledge`，模型给出的自然语言 acknowledge 一律判 `STATE_TRANSITION_INVALID`；L16 的冻结期望也是 enqueue_follow_up。所以 §6.3 那一格可以理解为「精确命令」的裁决。但文档没写明这一点，这和 R5-1 是同一类情况：Spec 没写清，实现方替用户选了一种解释。

两种处理：
- **A（推荐）**：保留 C，在 §6.3 EXECUTING 行追加一句：「自然语言的单纯延续由识别层输出 enqueue_follow_up 且 requestedEffects=[]；执行层对空效果的延续不重复派发，按 acknowledge 处理。（2026-10-20 用户决定）」只改文档，冻结哈希不变。
- **B**：按 §6.3 原文让模型输出 acknowledge。那就要改编译器或 L16 期望，超出本轮范围，而且要重新形成候选、重新冻结。

推荐 A 的另一个原因：缺执行器的问题已在已知缺口里记录（第二轮 R2-1）。将来接 enqueue_follow_up 执行器时，「空效果延续不重复派发」必须作为执行器的负向测试，否则会违反 §6.3 的「不重复派发」。

## 剩余记录

- H02 仍为 blocked（C 只推出 modify_source 一条禁止项，B 推出三条），这是既有限制。
- 所有结论都来自单次采样，稳定性由 R5-5 判断（新构建跑 3 次）。

## 下一步

1. 用户对上面的 A/B 做决定。
2. 监督方写新留出集 `tests/evaluation/intent-holdout-v3-2026-10-20.mjs`，在运行前冻结期望并报告哈希。留出集要覆盖 EXECUTING 下的自然语言单纯延续，以及 WAIT_USER_CONFIRM 下的补充需求，因为这两类是本轮新规则直接影响的。
3. 用户确认额度后，启动 R5-5 正式运行（三个构建；最终构建改为 C `ae37404e…`）。

---

# 第五轮决定与新留出集（2026-10-20）

## 用户决定：A

已在详细设计 §6.3 EXECUTING 行「其它约束」末尾追加（不改编号、不动其它行）：
「acknowledge 指精确命令的裁决；自然语言的单纯延续由识别层输出 enqueue_follow_up 且 requestedEffects 为空，执行层对空效果延续不重复派发，按 acknowledge 处理。（2026-10-20 用户决定）」
C 候选的冻结哈希不受影响。将来接 enqueue_follow_up 执行器时，「空效果延续不重复派发」必须作为执行器的负向测试。

## 新留出集 v3（监督方编写，C 冻结之后创建）

文件：`tests/evaluation/intent-holdout-v3-2026-10-20.mjs`，题号 V01–V12，导出 `holdoutCases` 和 `budgetCase`，格式与旧 H 集相同，判分检查项不变。夹具沿用现有脚本：一条 PostgreSQL 约束；correction 题再加一条「超时 10 分钟」旧约束。没有 artifact、资源、待确认记录或失败检查点。

| 题号 | 状态 | 覆盖点 | 期望 |
|---|---|---|---|
| V01 | PAUSED | 恢复正例新说法 | resume，空效果 |
| V02 | PAUSED | 维持暂停 + 记录偏好（反例：不得 resume、不得多拆段） | record_information / record_constraint |
| V03 | EXECUTING | 自然语言单纯延续（本轮决定 A） | enqueue_follow_up |
| V04 | EXECUTING | 延续 + 追加 | enqueue_follow_up / record_information，单段 |
| V05 | EXECUTING | 只问进度（反例：不得因延续规则变成 enqueue） | answer_in_chat，只读 |
| V06 | WAIT_USER_CONFIRM | 推迟确认 + 补充需求（L07 同类） | enqueue_follow_up / record_information |
| V07 | FAILED | 重试但无检查点 | clarify |
| V08 | WAIT_USER_CONFIRM | 带否定限定的独立任务 | create_independent_work_item，clean_task_context |
| V09 | WAIT_USER_CONFIRM | 两个真实独立目标 | 两段 |
| V10 | WAIT_USER_CONFIRM | 旧约束替换 | correct_route，绑定旧 Decision |
| V11 | WAIT_USER_CONFIRM | 不存在的引用 | clarify / reject_request |
| V12 | WAIT_USER_CONFIRM | 新约束而非纠错 | record_constraint |

已知不覆盖：「恢复 + 新要求另成段」。现有判分的 multi 检查只认 same_requirement + independent_new_requirement 两段组合，表达不了两段都是 same_requirement 的情况。只能改判分才能覆盖，本轮不做。

**未独立验证**：监督方 shell 仍被拦截，这个文件的语法与 SHA-256 还没实算。请 Codex 在正式运行前先实算哈希写入报告，之后文件不得修改。

## 正式运行前 Codex 需要做的唯一判分改动

`run-intent-codex-current.mjs:4,36` 目前只导入旧 H 集。R5-5 要求题集为「开发集 32 题 + 新留出集 + B01」，所以需要：
- 增加 `import {holdoutCases as holdoutV3Cases} from './intent-holdout-v3-2026-10-20.mjs'`；
- `--supervisor` 下的题集改为 `[...diagnosticCases,...holdoutCases,...holdoutV3Cases,budgetCase]`；
- 不改任何检查项、期望或夹具。

改完报告新的判分 SHA，三个构建使用同一份判分。这是 R5-5 允许的唯一判分改动，提示词与源码不得再动。

## 运行前准备复核：达标

- 留出集 v3：Codex 实算 SHA `801ec752…`，导入后 12 题（V01–V12）+ B01 可加载，文件内容与监督方写入的一致。
- 判分：`run-intent-codex-current.mjs` 只多出第 5 行导入和第 37 行题集拼接，与指令一致；新 SHA `ca37950a…`。Codex 已和冻结副本做逐字对比，断言这两处之外没有差异。
- B01 只从旧 H 文件加入一次，没有重复。正式题集共 45 个样本：L 20 + H 12 + V 12 + B01。
- C 源码/dist 仍是 `9025a242…` / `ae37404e…`；没有启动模型运行。

**仍未独立复算**：监督方 shell 被拦截，以上哈希都来自 Codex 报告，判分脚本的差异只核对了前 40 行。

## R5-5 启动条件

只剩用户确认额度。启动时三个构建都使用判分 `ca37950a…`；结束后 dist 恢复到 `ae37404e…` 并核验。

## R5-5 运行中复核（run-label `r5-formal-20261020-r1`，2026-10-20 11:05 启动）

编排脚本 `tests/evaluation/run-intent-r5-formal.mjs` 已逐行审读，符合 R5-5 要求：
- 启动前断言三个构建副本（`88d1b375…` / `5d3586dc…` / `ae37404e…`）、C 源码、判分 `ca37950a…`、V3 `801ec752…` 的哈希，并确认 V3 能导入 12 题 + B01。
- 5 轮（baseline、previous、current-1/2/3）× 5 批 × 9 题 = 225 个样本，串行执行；每批开跑前重新断言冻结文件和 dist 哈希。
- 子进程失败就整体判 `failed`，不会自动重跑，也不拼接成绩。
- `finally` 里把 dist 恢复为 C，写 `restoration.json`，并复核冻结文件。`.env` 只记哈希，不记内容。

首批 manifest 核对：buildHash `88d1b375…`（基线），源码哈希为 C，这是只换 dist 的既定做法；题集哈希 `9111f43c…`。

**运行期间的风险**：冻结范围包括 `apps/server/src`、`apps/server/dist`、`packages/shared/src`、`packages/shared/dist`，覆盖了整个后端和 shared。运行期间任何人改了其中一个文件（包括工作区里正在做的其它未提交改动），下一批就会以 `FROZEN_FILE_CHANGED` 终止，已跑的部分不能补拼。预计 1～1.5 小时内不要动这些目录，也不要跑会重建 dist 的 `npm run build`。

完成后监督方核对：`progress.json` 的 state 是否为 `complete`、25 批是否齐全；`restoration.json` 是否 restored=true 且冻结文件未变；冷却重试是否只出现在 0 调用的熔断题上；报告是否按 L / H / V3 分组，并给出 C 的逐题 3 次通过数。

---

# 第五轮 R5-5 正式结果复核（2026-10-20 11:05–12:19）

## 验收门槛：全部通过

| 门槛 | 结果 | 证据 |
|---|---|---|
| 执行覆盖 | state=complete，25/25 批，225 样本，225 份模型输出 | `progress.json`、`delivery-verification.json` |
| 冻结与恢复 | dist 恢复为 `ae37404e…`，源码未变，冻结文件未变 | `restoration.json` |
| 传输 | 脚本冷却重试 0 次；226 次调用里多出的 1 次是基线批产品内部重试，不是脚本补跑 | 报告传输表 |
| 报告结构 | L / H / V3 / B 分组；C 逐题 3 次通过数；逐检查项退步表；已知缺口 | `report.md` |

## 结果

| 集合 | 基线 | 上轮 | C（3 次） | 说明 |
|---|---:|---:|---|---|
| L 20 | 13 | 20 | 20 / 20 / 20 | 开发集 |
| H 12 | 7 | 9 | 12 / 12 / 12 | 已降为开发集 |
| **V3 12** | **4** | **9** | **11 / 11 / 11** | 唯一的泛化证据 |
| B01 | 1 | 1 | 1 / 1 / 1 | 语义通过；超 6000 仍发出 |

C 的 45 题里 44 题 3/3，1 题 0/3（V02），检查项 3 次结果全部一致。

## V02 的判定：更可能是监督方期望写窄了（不重判）

- 题面「先维持暂停。另外请记住，后面给我的说明都用表格列出。」C 三次都输出单段 `session_context` + `record_information` + `clean_task_context`，纯编译 applicable，没有拆出 pause 段，也没有 resume。
- 设计 §6.2 明确列出 `session_context` 可用 `record_information`、`clean_task_context`。「后面给我的说明」是会话级的表达偏好，不专指登录需求。我出题时把期望写成了 `same_requirement`，没有给这种同样合法的读法留余地。对照 L19，「以后向我解释当前登录方案时……」带明确的需求指向，题面不同。
- 结论：V02 失败主要反映期望范围过窄，不是 C 退步；基线和上轮在这题上本来就失败（拆出 pause 段）。**冻结成绩不改**，V3 仍按 11/12 报告，在报告里加注即可。今后写偏好类题目，要么在题面里写明需求指向，要么让关系期望同时接受两种合法读法。

## 新发现：计划结果的不稳定主要来自禁止项推断

识别检查 3 次一致是 45/45，但路由结构 3 次一致只有 26/45。变化最多的字段是 `prohibitions` / `outcome` / `errorCodes`（H02、H05、H08、V05、V12、B01 等），即模型有时多推出一条 modify_source 之类的禁止项，夹具里约束不了，于是同一题在 applicable / blocked 之间来回变。H02 在 C 的三次里分别是 blocked、needs_clarification、blocked。

这不影响本轮识别结论，但说明「纯编译结果」目前对采样很敏感。要处理就得在禁止项推断规则或编译器的「不可约束禁止项」策略上动手，后者属于编译器/范围解析器，超出本轮范围。

## 监督结论

R5 的完成标准全部达到：R5-1 有设计依据且经用户决定；H01/H11/H03 在开发集上修复；提示词净减；冻结哈希可复核；正式运行在冻结后新写的留出集上 V3 从 9/12 提到 11/12，3 次采样稳定，唯一失败已定性。

仍然有效、不能被本轮成绩掩盖的边界：新链路默认关闭；提交层对 resume / replan / retry_failed_step / 非测试 enqueue_follow_up 没有执行器；retry 检查点没有接线；空工具分类路径不执行输入预算（B01 实发 8404）。

监督方对 R5 不再要求 Codex 修改。之后做什么由用户决定，候选方向（每项都需单独放行）：
1. 禁止项推断稳定性（提示词或编译器策略）；
2. 新链路上线阻塞：IR06 / IR09 / IR11 / IR13（执行器、统一入口、灰度）；
3. 空工具路径的输入预算拦截。

**未独立复算**：监督方 shell 仍被拦截，所有哈希和计数都来自 Codex 生成的文件，我没有逐题翻原始 provider 输出，只抽查了 V02 和报告里的汇总表。

---

# 第六轮要求：输入预算超限 → 停止并由用户决定（2026-10-20）

## 用户决定

- 超出输入预算时**不发出**模型请求，停止当前任务，把情况告诉用户，由用户选择「继续」或「结束」。
- 「继续」= **只放行这一次调用**：按停下时的估算值放行同一个调用一次；不改任何预算配置，下次再超仍要询问。
- 「结束」= **只结束这次调用对应的任务**：Agent 任务取消该任务；新链路路由让这条消息不执行，会话回到原状态。会话保留，不置 CANCELLED。
- 范围：**新链路 `understand()` + Agent 执行任务**。默认线上的旧分类器（`intent_routing_decision`，4000 预算）**本轮不改**，避免改变当前线上消息路由行为。

本轮不提交（用户明确要求），不推送。

## 现状（监督方已读代码核实）

| 路径 | 现有预算检查 | 超限时的现状 |
|---|---|---|
| Agent 任务调用前 | `orchestrator.service.ts:8264-8273` 估算 agent/envelope/toolCatalog/expectedOutput | `tokenBudgetExceededResult` → `failed`，不问用户 |
| 工具循环每轮 | `generic-llm-runtime.service.ts:915-939` `assertWithinInputBudget`，在 `:341-367` 转成 `TOKEN_BUDGET_EXCEEDED` | 直接失败，不问用户 |
| 无工具请求 | `runOpenAiCompatible`（`:413` 起）**完全没有检查**；`runtime-invocation.service.ts` 也没有 | 照常发出（B01 实发 8404 > 6000） |
| 新链路路由 | `intent-understanding-routing.service.ts` 只有尝试次数/截止时间的 `INTENT_BUDGET_EXHAUSTED` | 不感知输入超限 |

可复用的范式：`sessions.service.ts:5598-5641` 的 `work_item_budget_exhausted`（WAIT_USER_DECISION + `createOnce` 确认卡，web/desktop `SessionWorkspace.vue` 都按 `confirmation.reason` 分支处理）；新链路已有 `canRetryIntentRecognition`（`failureClass: 'budget'`）+ `IntentRecognitionRetryPanel`。

## 第一步：先出设计，不写代码

先提交一份不超过一页的方案（写进 `docs/quality/` 下的新文件），监督方复核后再实现。方案必须回答：

1. **无工具请求的检查点放在哪**。要求在真正发出请求前用实际 messages 估算，口径与工具循环一致（`estimateTokens` + 输出保留 + `reserveInputTokenSafetyMargin`）；每次 attempt 都要检查，schema repair 也算。
2. **所有无工具 generic_llm 调用方清单**（grep `runtimeInvocation.invoke` / `runtime.start` 中 toolCatalog 为空的调用），逐个说明：属于本轮范围（新链路 understand、Agent 任务）的，停下询问；不属于的（旧分类器及其它），保持原行为。不能用「全局都拦」顺手改变范围外调用方的行为。
3. **Agent 任务**：三处守卫（调用前估算、工具循环每轮、无工具请求）超限后，如何统一转成 WAIT_USER_DECISION + 确认卡（建议新 reason `input_budget_exceeded`，选项「继续执行（本次放行）」/「结束此任务」）。说明「继续」重跑的是哪个粒度；**工具循环中途超限时，重跑会不会重复已执行过的有副作用工具调用**，如果会，给出防重复方案。
4. **新链路路由**：超限后 route 进入 BLOCKED，并使用新的 reason code（不要复用 `INTENT_BUDGET_EXHAUSTED`，那个是尝试次数/截止时间用的）；「继续」走现有重试入口，加一次性放行；「结束」只拒绝这条消息的路由。会话正在执行其它任务时，不得因此把整个会话置为 WAIT_USER_DECISION。
5. **一次性放行的约束**：持久化；绑定到具体对象（session + task/invocation，或 routing + revision）和当时的估算值；只能用一次；重估超过当时放行的估算值就要重新询问；只放行输入预算，不放行 `maxTotalTokens`、WorkItem 累计预算或任何授权检查；重复点击要幂等。
6. 前端：web 和 desktop 两端都要能显示和操作（只扩展现有确认卡/重试面板，不新建页面）。

## 第二步（监督方确认方案后）：实现与验证

- 先写失败用例再实现。至少覆盖：无工具请求超限时不调用 provider；超限后停在等待用户；「继续」只放行一次，第二次超限再次询问；「继续」后重估变大会重新询问；「结束」不取消会话；范围外旧分类器行为不变（回归测试）；schema repair 的第二次请求同样受检查。
- 跑 server 相关 spec、server typecheck 和 build；web/desktop 相关 vitest 和 vue-tsc。`generic-llm-tool-loop-budget.spec.ts` 本来就失败（TASK.md 有记录），本轮改到它时要分清是既有失败还是新退步。
- 改完后端要执行 `npm run dev:restart-server` 冒烟（本仓库后端不 watch）。
- 不改：路由编译器、范围解析器、提交层、新链路默认开关、`.env`、`semantic-intent-router` 的 L0 规则（R5 冻结版本）。不提交、不推送。

---

# 第六轮设计复核（针对 `intent-input-budget-r6-design-2026-10-20.md`）

结论：**有条件通过**。第 1、2、4、6 条可以直接实施；第 3、5 条按下面的修改简化后再实施。

## 通过的部分

- 第 1 条：在每次 fetch 前用实际 messages 检查，覆盖重试和 schema repair，口径与工具循环一致；超限不当作 provider 故障去重试或换模型。正确。
- 第 2 条：用服务端内部的 `inputBudgetPolicy` 显式标记范围，不按「工具目录为空」或 phase 推断，未标记的调用保持原行为。调用方清单完整，范围外各项都保持现状，符合用户的范围决定。
- 第 4 条：新 reason `INTENT_INPUT_BUDGET_EXCEEDED`，不复用 `INTENT_BUDGET_EXHAUSTED`，不改 Session 状态；「结束」只把这条路由置为 REJECTED，不调用 `cancelSession`。正确。
- 第 6 条：只扩展现有确认卡和重试面板，两端都做，验收清单覆盖了用户要求。

## 必须修改

### R6-M1 去掉工具循环「发送断点持久化」，改为重跑本次调用

监督方核实：工具循环只有三个工具，`read_file` / `search_code` / `read_attachment`（`generic-llm-runtime.service.ts:1220/1265/1283`），全部只读。写回走独立的 workspace writeback，不在这个循环里。所以中途超限后「继续」，从头重跑这一次 invocation 不会重复任何副作用，只多花 token。

方案第 3 条要持久化 messages、工具历史、usage 和 repair 阶段，有三个问题：
- 代价高。会把含文件内容和用户原文的完整 prompt 写进库，多出一类需要清理和脱敏的数据。
- 状态复杂。断点要跨重启保持一致，正是这一轮最容易出错的地方。
- 收益为零。工具全是只读的，没有需要防的重放。

要求：
- 「继续」= 重新执行同一个调用槽位（同一个 task/phase/逻辑调用），一次性放行它的输入预算检查。不持久化 messages 或工具历史。
- 增加一条守卫测试：断言工具循环可调用的工具集合恰好是这三个只读工具。将来有人往循环里加有副作用的工具，这条测试会失败，提醒重新评估防重放。
- Claude Code / Codex 等适配器的调用前守卫在适配器启动前就触发，这时还没有任何执行，重跑同样安全。

### R6-M2 一次性放行不要绑定 requestHash

重跑会重新组装 envelope（含 `createdAt` 等时间字段），重估的轮次也可能不同，requestHash 必然变化，按方案第 5 条就会每次都要求重新询问，「继续」永远用不了。

要求放行绑定：actor + session/dataEpoch/generation + 调用槽位（task + phase + 逻辑调用，或 routing + revision）+ 停下时的 E/R/C。放行规则：本次重跑的任意一轮 `E+R ≤ 停下时的 E+R` 就允许发送；超过就重新询问。其余约束（持久化、发送前 CAS 消费一次、双击/并发/重启不复用、不豁免 maxTotalTokens / WorkItem 累计预算 / 授权、结束幂等）保持方案原文。

工具循环说明：一个放行在整次重跑内有效（循环里多轮各自比较上限），而不是只放行一轮。否则第 2 轮又超限，用户要连续点好几次「继续」。

## 实施要求（获准后）

按方案第 6 条的验收清单先写失败用例再实现。另外加两条：
- R6-M1 的只读工具集守卫测试；
- 「继续」后重跑的工具调用次数可以和首次不同，但 workspace writeback 记录数必须是 0。

其余验证与第六轮要求一致：server spec / typecheck / build、web 与 desktop vitest / vue-tsc、`npm run dev:restart-server` 冒烟。`generic-llm-tool-loop-budget.spec.ts` 的既有失败要单独说明。不提交、不推送。

---

# 第六轮实施复核（针对 `intent-input-budget-r6-2026-10-21/report.md`）

结论：**实现符合 R6-M1 / R6-M2，范围没有跑偏**；还差监督方独立复跑测试这一步。

## 已核对（读代码）

- `input-budget-store.ts`：放行绑定 actor + dataEpoch + generation + slot + routingRevision 和停下时的 E/R/C，没有 requestHash，也不落 messages。重跑判据是 `E+R ≤ 停下时 E+R`；同一 invocation 加同一进程内整次重跑都有效；换 invocation 或进程重启后要重新询问；`ended` 之后拒绝再发；决定幂等，冲突决定返回 409。符合 R6-M2。
- 「结束」只把 hold 置为 `ended`，这个 store 里没有任何会话级取消调用。
- 四个范围外文件的说明（M-001）成立：controller 新增决定接口；workflow-runtime 只补一个 outcome 分支，否则预算等待会落进失败处理；web 两个 store 只做 API action 和字段投影。都是接线所必需的，没有新增能力。
- HTTP 401：R6 之前的 2026-10-19 报告就有记录，探测方法和 `.env` 哈希都没变，归为本地连接的既有认证问题，可以接受。

## 提示（不阻塞）

- 新接口 `POST /sessions/:id/input-budget/decision` 和本 controller 里其它接口一样，没有独立的身份认证；actor 来自 `session.ownerId`。这与仓库现状一致（本地单用户），但如果将来要对外暴露服务，这一类决定接口都需要补认证。
- `event.ts` 的 `inputBudgetDecision` 跨刷新投影没有专门的断言，报告已经如实写明。

## 未独立验证

监督方 shell 这次仍被安全分类器拦截，496 / 54 的测试结果来自 Codex 的日志和 verification.json，还没有自行复跑。shell 恢复后要复跑这几个文件：`generic-llm-input-budget`、`input-budget-store`、`input-budget-tool-rerun`、`generic-llm-tool-loop-budget`、`intent-message-pipeline` 的 spec。

补充（2026-10-21）：按 M-002 由 Codex 在新进程复跑上述 5 个文件，`evidence/supervisor-rerun.log` 显示 36/36 通过，exitCode=0（08:33:56）。不是监督方亲自执行，但是一次在当前代码上的完整实跑记录。

---

# 第七轮设计复核（针对 `intent-executor-r7-design-2026-10-21.md`）

结论：**有条件通过**，条件见收件箱 M-003（C1–C3）。

通过的部分：授权来源定为 `IntentRouteRevision.validatedPlan` 的执行 step 和 grants，明确 Brief 收据、流程选择都不构成执行授权；找不到或不唯一时阻止，不挑「最新」；resume 与精确命令「继续」走同一条 `SessionsService.resume()` 路径；守卫表逐项有错误码；崩溃后进入 reconciliation_required，不盲目重试；R6 预算等待优先于 resume。

修改条件：
- C1：新守卫只作用于 `intent-understanding-v1` 会话，旧链路会话的「继续」完全不变，并加回归测试锁住。
- C2：空效果延续只有在确实有活动执行时才 acknowledge，否则用 `INTENT_CONTINUATION_NOT_ACTIVE` 阻止，避免掩盖卡死的任务。
- C3：两个入口（精确命令、自然语言）都要测预算等待优先。

提示：现有会话多数没有完整的执行授权链，按设计会得到 `INTENT_RESUME_AUTHORITY_UNPROVEN`。这是有意的 fail-closed，新链路默认又是关闭的，所以不影响线上；但打开新链路之前要评估命中率。

---

# 第七轮实施复核（针对 `intent-executor-r7-2026-10-21/report.md`）

结论：**通过**。C1–C3 都有对应实现和测试；303/303、typecheck、build、重启冒烟均为 exit=0（来自 Codex 日志，监督方未自跑）；四个受保护文件哈希不变。

抽查代码：
- `queue/execution.worker.ts:72` 只在 `intent-understanding-v1` 会话上读取 `intentResumeBinding`；旧链路仍走原来的 `resetStaleRunning` + `unfinished` 分支（`:96-98`），C1 成立。新链路只重置、派发原绑定的任务，任务缺失、跨 WorkItem 或已终态都会 `INTENT_RESUME_TARGET_OBSOLETE`。
- `persistence/intent-record-invariants.ts` 的放宽范围很窄：`resumeReceipts` 只能追加；binding 和认领身份不可变；状态只能从 running 推进到终态；同一次暂停身份不能重复。step 的其它不可变约束保持不变。

需要知道的限制（报告已如实列出）：
- `reconciliation_required` 只会阻止盲重试，目前没有处理入口和前端提示。真的遇到时，用户只看到阻止，没有下一步可操作。
- 并发只在同进程和 File 后端上验证过，Redis / Postgres 多进程没有覆盖。
- 历史会话大多会 `AUTHORITY_UNPROVEN`。

范围：18 个文件，比设计 §4 多 6 个，报告逐个说明了原因，都是接线和测试夹具，没有新增能力。

---

# 第八轮设计复核（针对 `intent-executor-r8-design-2026-10-21.md`）

结论：**有条件通过**，条件见收件箱 M-005。

通过的部分：检查点来源找对了。现有恢复卡、`executionCheckpoint`、LogicalOperation 单独都不足以证明可以重试，所以在失败时写入不可变 retryBinding；缺证据就只生成原恢复卡，不补造。编译器不改，只在调用方补参数。语义提交和精确命令走同一条路径，旧链路不变。效果未知时阻止；R6 预算等待优先。

收窄（用户 2026-10-21 决定）：原设计做 candidate → submission → writeback 的阶段接续，这是一种新的执行能力，要大改 orchestrator；而且「运行时内部失败一律不支持」，正好把最常见的失败（模型或运行时报错）排除在外。改为只重跑失败的那一个任务：该次失败没产生候选、提交或写回时重跑；已产生的走现有写回处理入口；兄弟任务和上游步骤不重做。已写入设计 §6.3 FAILED 行。

新增要求：本地 CLI 类 Runtime 可能直接改工作区，不能证明没有直接写入时就阻止重试，报告要逐个 Runtime 给出代码依据。

---

# 第八轮实施复核（针对 `intent-executor-r8-2026-10-21/report.md`，已随 `7f921c1` / `5ded526` 提交）

结论：**通过**。按用户决定只重跑失败的那一个任务，没有做阶段接续；测试 535/535，typecheck、build、重启冒烟通过（来自 Codex 日志，监督方 shell 被拦，未自跑）；7 个受保护文件哈希不变。

抽查代码：
- `runtimes/runtime.service.ts:321-323`：只有携带 `intentRetryBinding` 且是新链路会话时，才在最终选中的适配器启动前调用 `assertIntentRetryRuntimeSafe`，旧 Runtime 选择不受影响。
- `sessions/sessions.service.ts:6357`：非 `intent-understanding-v1` 会话直接走原 `resumeWithBinding`，旧链路的 `retryFailedSession`（`:5421`、`:6462`）调用点保留，C1 成立。
- 报告逐个 Runtime 给了代码依据：generic_llm / code_reader / mock 允许；codex / claude_code / test_runner / mcp_tool / human 一律阻止。保守但合理，CLI 类目前完全不能走新链路重试。

值得肯定：保留原 operation，不新建 operation 来重置预算；`retryReceipts.status=applied` 只表示调度被接受，和执行结果分开记录。

累计缺口（R7、R8 都有，越来越实际）：派发或执行结果不明时进入 `reconciliation_required`，之后没有任何出口。用户只看到阻止，不能确认、不能放弃，也没有前端提示。下一轮 R9 处理这个问题。

---

# 第九轮设计复核（针对 `intent-reconciliation-r9-design-2026-10-21.md`）

结论：**有条件通过**，条件见收件箱 M-007。

通过的部分：
- 来源清单完整，6 类都找到了存储位置。
- 统一展示证据，但三个动作只开放给 R7 / R8 两类来源，其余来源只读，并指向原有处理器。
- 证据只展示服务端已有的事实。「未记录」不等于「未执行」，拿不到就写「未知」。
- 三个动作都要求事务内重读、CAS 加幂等键，并且和正常派发共用持久化栅栏。
- ①「重新派发」完整重走 R7 / R8 守卫，R6 预算优先；②③零派发；原回执不可变。
- CLI 例外按要求列为待决项，没有擅自采用。

**用户决定（2026-10-21）：CLI 例外采用「显式确认后放行」**。范围只限 codex / claude_code，只对单个案件的单次 attempt 有效；要记入审计；R6、R7、R8 的其它守卫一律不豁免；mcp_tool / test_runner / human 仍然阻止。

修改条件：
- 拆成两轮。R9a 只做服务端（案件存储、API、三动作、CLI 确认、File 和关系型持久化）；R9b 做 web / desktop 卡片。设计涉及约 20 个文件，还有新的关系型表和迁移，一次做完风险太高。
- ②「按完成处理」之后会话去哪里，原设计没写，会造成新的死路。要求会话进入和 R8 单任务重试成功后相同的状态（WAIT_USER_DECISION 并附结果通知），用户可以继续往下走，并加测试。
- 新的关系型表要写迁移，编号接在仓库当前最新之后。PostgreSQL 集成测试必须用独立的一次性库，不能连主库（memory 记录过：集成 spec 直连主库会软删真实会话）。

---

# 第九轮 R9a 实施复核（针对 `intent-reconciliation-r9a-2026-10-21/report.md`）

结论：**通过**。测试 591 项，590 通过，1 项 PostgreSQL 集成测试跳过（没有测试库 URL）；typecheck、build、重启冒烟通过（来自 Codex 日志）；9 个受保护文件哈希不变；web / desktop 没有改动。

抽查：
- `intent-reconciliation.integration.spec.ts:14-21`：只从 URL 取凭据，管理连接固定连 `postgres` 维护库，新建 `agent_cluster_r9a_<pid>_<ts>`，并断言库名不等于 `agent_cluster`，跑完 drop。不会碰主库，满足条件。
- 迁移 V24 接在 V23 之后；新表走现有 `INTENT_RECORD_TABLES` 通用路径，没有重复改 PersistenceService / RelationalStateStore。
- 动作 ② 之后会话进入 WAIT_USER_DECISION 并发通知，不推进下游，补充条件成立。

**重要发现：用户批准的 CLI 例外目前不会生效，原因不在本轮。** `packages/shared/src/intent-runtime-policy.ts:27-35` 的 `supportsIntentEffectScope` 对 codex / claude_code 一律返回 false。这意味着新链路的 `task_execution` 本来就不能在 CLI 上跑，不只是重试。CLI 根本不会产生 R8 的重试绑定，人工确认放行的那道门永远走不到。Codex 没有为了让测试变绿去放宽这个策略，这是对的：放宽它等于给 CLI 新增执行能力，对应 SDD 的 IR05.3（能力传到实际 sandbox / Bridge，并有执行证据），是另一项更大的工作。确认逻辑和审计已经接好，等 IR05.3 完成后自动生效。

未验证：PostgreSQL 实库并发与迁移没有跑；三动作 HTTP 端到端没有跑；R9b 前端未做。

---

# 第九轮 R9b 与 PostgreSQL 补验复核（针对 `intent-reconciliation-r9b-2026-10-21/report.md`）

结论：**通过**。人工对账从服务端到两端界面已接通。

- PostgreSQL：4 个集成 spec 在一次性库里 37/37 通过。主库 `agent_cluster` 的会话数 16、软删会话 4、迁移版本 22，前后不变，没有重演软删事故。主库迁移停在 22，说明 R9a 的 V23/V24 还没应用到开发库。这是因为冒烟用的是隔离数据；下次真实执行 `npm run dev:restart-server` 时会自动执行这两个 additive 迁移，属于正常现象，但应该知道。
- 前端：先红（18 项新用例失败）后绿；11 个文件 103/103；两端 vue-tsc、build 通过。共享 `IntentReconciliationCard.vue` 和 `intentReconciliationModel.ts`，两端复用同一套验收用例，没有新建页面。
- 「未记录」与「未执行」分开显示；只读来源不显示三个动作；CLI 勾选文案如实说明「可能仍被阻止」；幂等键由案件版本和动作固定生成，刷新和重试都不会重复提交。
- 后端零改动：2,297 个 server / shared / dist / .env 文件哈希没有差异。

未验证：真实浏览器和 Electron 的实机操作链路，只用了组件加 mock HTTP。

---

# 第十轮设计复核（针对 `intent-follow-up-r10-design-2026-10-21.md`）

结论：**通过**，按设计建议拆成 R10a / R10b。

- 根本阻塞已核实：目前没有任何 Runtime 接受 `modify_source`（`intent-runtime-policy.ts:27-35`），提交层也没有接源码写入。所以 R10 的实际范围是「让新链路第一次能安全地改源码」（IR05.1–IR05.4 的 generic_llm 窄切片）。
- 路径选对了：模型只产出候选，服务端生成 ChangeSet，经现有 writeback 门落盘。generic_llm 仍只有三个只读工具，不开放 `write_file`。
- 强制点落在实际写入层：enqueue、force、冲突编辑、锁内合并后的最终内容都要重新校验授权和禁止项，force 也不能豁免。「不改表结构」这类禁止项无法可靠验证时就阻止，不自动写回。
- `execution-scope-resolver` 不需要改，保持冻结。
- 追加入队时不递增版本，以免让正在执行的任务失效；激活时 requirementRevision +1，需要新 Brief 并经真实确认后才派发。

**用户决定（2026-10-21）：批准 R10a，允许修改 `intent-runtime-policy.ts`**，只放开 generic_llm 的「只读候选 → writeback」模式。编译器、`execution-scope-resolver`、semantic-intent-router、默认开关仍冻结。

提示：按设计，每一条追加需求在激活时都要生成新 Brief 并经确认。这符合 SDD，但会多一张确认卡，到 R10b 时要留意体验。

---

# 第十轮 R10a 实施复核（针对 `intent-source-write-r10a-2026-10-21/report.md`）

结论：**通过**。新链路第一次能够安全地改源码，目前只通过夹具接通，生产入口还没有开放。

- 测试：30 个文件 769 项，768 通过，1 项跳过（Windows 创建文件 symlink 返回 EPERM；junction 负例已实测通过）。typecheck、build、隔离重启通过（来自 Codex 日志）。
- 真实写回冒烟：在临时 git 仓库里，越界候选被 `INTENT_SOURCE_FILE_OUTSIDE_MANIFEST` 拒绝，文件 hash 不变；合法候选经 writeback 后 hash 变化。这是本专项第一次在真实文件上验证写入边界。
- 抽查 `packages/shared/src/intent-runtime-policy.ts:48-68`：只有携带 `sourceCandidateBinding` 时才进入新分支，而且只接受 generic_llm；`intentScopeToolNames` 在这个模式下只返回 `read_file` / `search_code`，不会出现 `write_file`。旧路径的判断原样保留。符合用户批准的范围。
- 写入层的做法很扎实：用固定文件句柄并核对 dev/ino，防止检查后被替换；撤权与 applying 互斥；失败回滚；不能证明回滚成功时保留 unknown 栅栏。
- 没有新增表或迁移，复用 Session JSON。7 个受保护文件哈希不变，双端 241 个文件逐字节不变。

需要知道的限制：
- `no_schema_change` 只支持在顶层函数开头插入纯 `if … return` 这一种形态。所以带「不改表结构」约束的追加需求，大多数会被阻止、不自动写回。这是失败关闭，但实际命中率会很低。
- 源码 apply 的 unknown claim 和 R9 之前一样没有出口，会阻止后续 apply 和撤权。R9 的三个动作不覆盖它。R10b 一并处理。
- PostgreSQL 只做了 codec / 投影单测，没有连真实库。

提交情况：R9 没有在 R10a 开工前单独提交，现在 R9 和 R10a 的改动在工作区里混在一起，而且有共同修改的文件（如 `runtime.service.ts`），无法按轮次干净拆开，改为合并成一组 commit。

---

# 第十轮 R10b 实施复核（针对 `intent-follow-up-r10b-2026-10-21/report.md`）

结论：**不通过**，返工见收件箱 M-012。实现代码有实质内容（授权、入队、静止激活、Brief 后单任务派发、unknown claim 出口），但验证没有覆盖设计验收，交付要求也有缺项。

具体问题：
- `intent-follow-up.service.spec.ts` 只有 4 条测试，其中 2 条只断言 `typeof ... === 'function'`。设计第 6 节验收 3（入队不升版本、静止条件、只 +1 一次、拒绝零派发、重复与重启不重做、基线变化阻止）都没有行为测试。
- 回归从 R10a 的 769 项降到 725 项，报告没有说明。
- `full-chain-smoke.log` 只有一行，只走到「创建 1 个任务」，没有覆盖 M-011 要求的「候选 → writeback → 文件 hash 变化」。
- M-011 明确要求而没做的：点击次数统计；接入 R9 案件视图；`intent-runtime-policy.ts` 逐行说明；verification.json；设计范围外文件清单。
- 代码问题：`scan()` 每 2 秒跑一次，出错时 `.catch(() => undefined)` 吞掉，激活失败用户看不到，并且会无限重试；`tryCommit` 以 `paths: []` 发起授权请求，最终文件清单的来源和服务端校验没有说明。

旁注：本轮 Codex 换成了 `gpt-6.1-sol`，最后一次调用报 `server_overloaded`（报错在交付完成之后），交付质量明显低于前几轮。

## R10b 返工（M-012）复核

已解决：
- 只检查函数存在的测试已删除，换成 6 条行为测试，覆盖授权（owner 决定、CAS、幂等、空清单和越界拒绝）、入队不升版本且幂等、静止条件逐项、扫描失败持久化且不重试、激活只 +1 且 Brief 后只建 1 个任务、unknown claim 证据过期时拒绝和幂等。
- 回归数量说清楚了：R10a 原 30 个文件逐个复跑，项数没有减少；上次的 725 项是少跑了文件。现在是 32 个文件 776 项，774 通过，2 项跳过（symlink 权限、没有一次性 PostgreSQL 库）。
- 完整链路冒烟按步骤留了日志：授权 → 入队（版本 1 不变）→ Brief 确认（版本 2，1 个任务）→ 越界候选被拒（hash 不变）→ 候选 → writeback（hash 变化）。
- `scan()` 吞错误的问题已修：失败原因持久化，置为 blocked，发事件，不再重复激活。
- 授权文件清单不再由请求体传入，改为 owner 在 approve 决定里提交，服务端在签发前校验根、路径、文件存在、大小和数量。
- 点击次数：一条追加需求从提交到落盘，用户要点 2 次（源码授权卡、新 Brief 确认）；写回结果不明时再多一次对账。
- unknown claim 以 `source_writeback` 来源接入 R9 的案件视图（只读），三个动作走专用接口，理由成立。
- `intent-runtime-policy.ts` 本轮未修改，前后哈希一致；verification-r2.json、typecheck、build、重启冒烟证据齐全。

仍缺的行为测试（M-012 第 1 点列出的）：
- 基线变化（文件 hash、Decision 集、workspace binding）时激活被 blocked；
- 多实例并发、进程重启后只激活一次；
- Brief 被拒绝或取消时零派发；
- unknown claim 的「确认未写入后只能再 apply 一次」和「放弃后不能再 apply」，目前只测了「确认已写入」。

代码里这几处都有对应实现（`activate` 的基线比较、`cancel`），缺的是测试证明。这是 R10b 第二次因为「验证不足」被退回，按 Harness 规程（同一信号第二次返工须停下问用户），交用户决定。

**用户决定（2026-10-22）：R10b 有条件通过**，缺的 4 类测试作为 R10c 的第一项先补（先红后绿），不再单独开一轮返工。

## M-013 复核

- **A 通过**。监督方 shell 自跑核对 `regression-r3.log`：780 项，778 通过，0 失败，2 跳过；`intent-follow-up.service.spec.ts` 10 条测试名与要求的 4 类一一对应。测试暴露并修复了两个真实缺陷：workspace binding 变化原先直接抛错，没有持久化为 blocked；redispatch 之后可以无限次 apply。这说明补测试是有价值的。R10b 至此完整通过。
- **B 按停止条件停下，判断正确**：授权决定接口仍由客户端提交 `paths`，服务端没有给出候选文件列表。Codex 没有在前端拼路径，也没有为了绕过而改服务端 API。
- 提交状态：HEAD 仍是 `5ded526`，R9、R10a、R10b 都没有提交，工作区里有 50 个已跟踪文件改动。

## M-014 复核（R10c）

结论：**有条件通过**，小修见 M-015。

A（候选接口）：
- 回归 782 项，780 通过，0 失败，2 跳过（监督方自跑核对日志）。新增 2 条测试覆盖敏感文件、`.gitignore`、分页、suggested 不自动授权，以及 `paths` / 伪造 / 跨请求 / 过期引用被拒。
- 过滤用的是 shared 里已有的 `isSensitiveWorkspacePath` / `isGeneratedWorkspaceDirectory` / `isWorkspaceTextContent`，并且跳过 symlink，与现有规则保持一致。
- **问题（读代码发现）**：`intent-source-authorization-candidates.ts:71,100` 先按广度优先、字母序扫描，扫到 500 个文件就停，**之后才**按 `query` 过滤（`:105-106`）。超过 500 个文本文件的仓库（本仓库就是），深层文件无论怎么搜都搜不到。例如 `apps/server/src/modules/sessions/sessions.service.ts` 排在前 500 之外。搜索是授权卡唯一的选择方式，所以在大仓库里卡片实际不可用。现有测试的夹具很小，测不出来。

B（双端卡片）：
- web 580/580、desktop 14/14、两端 typecheck 和 build 通过（来自 Codex 报告）。三张卡都有了，批准时只提交 `candidateRefs`，并断言不带 `paths`。
- 服务端没有暴露单条追加需求的取消路由，卡片上的「取消」按钮会一直 404。Codex 遵守了「B 不改服务端」的约束，如实报告了这个问题，没有私自加路由。
- 新增的 3 个组件测试各只有 1 条，M-014 要求的这些没有覆盖：刷新恢复、409 后重读、过期引用提示重选、重复点击只发一次、hash 不一致时动作禁用；也没有 desktop 侧对应的用例。

## M-015 复核（R10c r2）

结论：**主体通过**，收尾见 M-016。

- 候选搜索（读代码核对 `intent-source-authorization-candidates.ts:79-131`）：遍历时按 `query` 过滤；不匹配的文件只做一次 `lstat`，不读全文；500 的上限只作用于匹配项；另有条目数和耗时两个扫描预算，耗尽时返回 `truncatedReason`。测试用 610 个文件、四层深路径的夹具验证深层文件能被搜到。修法正确。
- 取消路由：`POST /sessions/:id/intent-follow-ups/:followUpId/cancel`，同键幂等，状态或 revision 不符返回 409，取消零派发。前端去掉了 404 特殊提示。
- 前端新增：授权卡的「结果不完整」提示、409 后重读且不重投、过期引用提示重选；状态卡的取消成功与 409 刷新；对账卡 hash 不一致时动作禁用并显示原因。

剩余缺口：
- 回归排除了 `intent-reconciliation.service.spec.ts`，理由是「nested tsx missing」。这是 R9 的核心测试，R10b-r2 时 38/38 通过，失败是运行方式造成的，不是代码问题，不能排除。
- 授权卡缺「刷新恢复」和「重复点击只发一次」两条测试；desktop 是否复用 web 组件没有说明。

## M-016 复核（R10c r3）

结论：**通过**，R10（带效果追加需求，服务端加双端界面）收尾。另发现一个 R9a 引入的回归，见 M-017。

- R9 对账 spec 用仓库根目录的 tsx 单独跑，38/38 通过，证明之前的排除确实是运行方式问题。
- 授权卡补上「重新挂载后从服务端恢复」和「快速连点只调用一次」两条测试，定向 4/4；web 全量 584 通过。
- desktop 复用 web 组件有依据：`apps/desktop/vite.renderer.config.mjs` 把 `@` 指向 `apps/web/src`，`ConfirmationCard.vue` 直接 import `@/components/IntentSourceAuthorizationCard.vue`。desktop 14/14，两端 vue-tsc 通过。

**归因纠正**：报告把 `cutover-context-v2-cli.spec.ts` 称为「既有基线失败」，同时又写它在 `5ded526` 上 11/11 通过。这两件事放在一起，说明失败恰恰是 `5ded526` 之后的未提交改动引入的。监督方读代码确认：`buildV2SeedState()`（`cutover-context-v2.cli.ts:83-84`）有 `intentCorrectionsBySession`、`intentPlanStepsBySession`，但没有 R9a 新增的 `intentReconciliationsBySession`（V24）。v2 切换时这张表不会被重置。M-015 的排除清单和 M-016 的指令都沿用了「既有失败」的说法，监督方当时也没核对，这里一并纠正。

## M-017 复核（R10c r4）

结论：**通过**。`buildV2SeedState()` 已补上 `intentReconciliationsBySession`（`cutover-context-v2.cli.ts:85`）。实际比对 `relationalCollectionKeys()` 与 seed 的差集：修复前缺这 1 项，修复后两边各 50 项、完全一致，说明 R9a–R10c 没有漏掉其它集合。cutover 11/11、R9 38/38、follow-up 15/15。

用仓库标准命令 `npm run test -w @agent-cluster/server` 跑全量时 2545 项中有 2 项失败。监督方定位后确认都是测试自身的问题：
- `intent-reconciliation.service.spec.ts:280` 用相对路径 `node_modules/tsx/dist/cli.mjs` 启动子进程。workspace 测试的 cwd 是 `apps/server`，tsx 装在仓库根目录，所以只有从根目录运行时才通过。之前几轮「R9 38/38」都是从根目录跑的，这个问题一直被掩盖。
- M015 深层搜索测试没有指定 `scanBudget`，用的是生产默认的 2 秒，全量并发时会超时被截断。生产上的影响有限：超时时返回 `truncated` 并提示用户输入更具体的路径，不会静默给出错误结果。

两项都在 M-018 里修，只改测试。

## M-018 复核（R10c r5）

- 子进程路径：改为 `createRequire(import.meta.url).resolve('tsx/cli')`，tsconfig 也按模块位置定位，不再依赖 cwd。正确。
- 标准命令 `npm run test -w @agent-cluster/server` 连续两次：2545 项，2502 通过，0 失败，43 跳过；dev 7/7（来自 Codex 报告）。
- **深层搜索测试失去了判别力（监督方读代码发现）**：新夹具在根目录写了 `.gitignore`，内容是 `noise/**`，610 个噪声文件全放在 `noise/` 下。扫描器遇到被忽略的目录直接跳过，不会进入，所以这条测试实际只遍历了几个条目。即使换回 M-015 之前「扫到 500 个就停、之后才过滤」的错误实现，它也照样通过。这正是 M-015 要防的问题。
- 监督方已直接修改这条测试（只改 spec，不改产品代码）：去掉 `.gitignore`，让 610 个噪声文件真正参与遍历，并且按字母序排在 `z1/` 之前。旧实现会在到达 `z1/` 之前停下，新实现应当找到 `needle.ts`。时间预算仍然显式给 10 秒。
- **监督方 shell 被分类器拦截，没能运行这条修改后的测试**，交给 Codex 在 M-019 里运行验证。

## M-019 复核（R10c r6）

结论：**通过**。R10 全部收尾。
- 修改后的深层搜索测试：当前实现下通过；临时换回「先扫满 500 个再过滤」的旧实现后失败（结果为空，期望 `z1/z2/z3/z4/needle.ts`）；恢复后再次通过。测试现在能判别 M-015 要防的错误。
- 产品文件恢复确认：`intent-source-authorization-candidates.ts` 的 SHA-256 前后都是 `7639E9F5…D351`，和 M-015 交付时 `verification-r2.json` 记录的一致，临时改动没有留在工作区。
- 标准命令 `npm run test -w @agent-cluster/server`：2545 项，2502 通过，0 失败，43 跳过；dev 7/7。

R10 阶段总结：带效果的追加需求从服务端到双端界面已接通。用户点击 2 次（源码授权、新 Brief 确认）；写回结果不明时多 1 次对账。新链路默认仍关闭。

---

# 方向核对与调整（2026-10-22）

用户要求核对当前工作是否偏离最初目标。监督方结论：**偏离了**。

最初目标（用户 10:01 的原话）：用本地 Codex 真实模型评测意图识别和路由，针对失败题目优化，给出优化前后对比报告，不要再扩展工作流功能。
- R1–R5 对口：评测、识别提示词优化、对比报告；R5 在新留出集上 9→11/12，3 次采样一致。
- R6–R10 偏离：预算拦截、resume / 重试执行器、人工对账、新链路改源码能力（授权、候选、写回、队列、三张卡），都是新链路的执行层功能，与「识别」无关，也违背了「不要再扩展工作流功能」。R11 replan 已取消。
- 偏离的原因：R5 收尾时监督方推荐了「新链路执行器」方向，之后每轮都是「补下一个缺口」；用户每次批准的是具体决策，「整体要不要往这个方向走」监督方没有单独拿出来问过，也没有指出它违背了最初约束。这是监督方的失误。

**用户决定（2026-10-22）：回到最初目标。** R6–R10 先提交保存，不再往上加功能；接下来只做识别本身，从 R5 留下的两个问题开始（3 次采样路由结构只有 26/45 一致；V02 的期望范围）。见收件箱 M-021。
