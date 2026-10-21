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
- 压缩 relation/contextPolicy 与限定语规则，保留真正多目标拆分、否定作用域、未知关系澄清、已有任务继承等约束。没有加入题号或题面措辞。

使用 [离线测量脚本](../../tests/evaluation/measure-intent-r5-prompt.mjs)，读取上一轮 B01 实际 envelope 和提供方请求，仅替换四条变化的规则；验证替换位置、源码与已构建 dist 内容一致：

| 指标 | 修改前 | 修改后 | 差异 |
| --- | ---: | ---: | ---: |
| L0 全部 12 条规则总字符数（UTF-16，逐条 length 求和） | 3901 | 3748 | -153 |
| 同一 B01 请求估算输入 token（JSON messages 字符数 / 4 向上取整） | 8412 | 8374 | -38 |

测量记录：`intent-codex-comparison-2026-10-20/r5-freeze/prompt-measurement.json`。B01 修改后是同请求离线重建估算，未向模型发送 B01，不是新模型用量或语义成绩。8374 仍高于配置的 6000；空工具分类路径未执行输入预算拦截的已知缺口仍存在，本轮未修复。第一轮候选的 3641 字符 / 8347 token 测量也保留在 `explore-a-prompt-measurement.json`。

## R5-4：验证和开发探索

已完成定向测试（semantic router + route compiler）33/33、server typecheck、server build，退出码均为 0。编译器仅运行既有测试，没有修改实现。新增测试验证实际运行时构造器收到恢复/延续分段规则且仍禁止业务效果；它不证明模型一定遵守规则，真实输出另行记录。

验证日志位于 `intent-codex-comparison-2026-10-20/r5-freeze/`：`targeted-tests-final.log`、`typecheck-final.log`、`build-final.log`。评测传输处理的既有 10 项回归也通过，见 `transport-tests.log`；测量和冻结脚本通过语法检查。

开发探索使用实际 SemanticIntentRouter、持久化分类服务、Generic LLM Runtime、本地 Codex HTTP 桥和纯路由编译器；无业务动作派发。沿用串行、0 调用熔断冷却重试限制，题集 SHA 与上一轮一致。以下结果只说明看过的开发题表现，不计正式成绩。

第一轮候选 `cec5952e…` / `b4b1d100…`，标签 `explore-r5-a-20261020-h01-h03`：H01 通过（resume、空效果），H03 通过（单个 enqueue_follow_up），H02 失败（多拆 pause 段，action、routeState、goalSegmentation 三项失败）。该轮的源码、dist、原始模型输出和体积测量均保留，未覆盖失败样本。随后补入“维持现状是限定语”的通用规则。

最终候选的探索标签为 `explore-r5-b-20261020-h01-h03`、`explore-r5-b-20261020-h10-h12`、`explore-r5-b-20261020-l11`、`explore-r5-b-20261020-l16`。历史列只引用上一轮 `serial-confirmed-20261020-r3` 的优化后结果，未重判历史数据；当时尚无 resumeDeclaresNoEffects 检查。

| 开发题 | 上一轮观察 | 第一轮候选 | 最终候选观察 |
| --- | --- | --- | --- |
| H01 | positiveResumeApplicable 失败 | 通过 | 检查通过；resume、空效果、纯编译 applicable |
| H02 | 检查通过，纯编译 blocked | action / routeState / goalSegmentation 失败 | 检查通过；一个 answer_in_chat，纯编译 blocked |
| H03 | goalSegmentation 失败 | 通过 | 检查通过；一个 enqueue_follow_up，纯编译 needs_clarification |
| H10 | 检查通过 | 未跑 | 检查通过；replan |
| H11 | positiveResumeApplicable 失败 | 未跑 | 检查通过；resume、空效果、纯编译 applicable |
| H12 | 检查通过 | 未跑 | 检查通过；record_constraint |
| L11 | 检查通过 | 未跑 | 检查通过；保留两个真实目标 |
| L16 | 检查通过 | 未跑 | action、routeState 失败；输出 acknowledge，纯编译 needs_clarification |

H03 虽通过识别检查，纯编译仍为 needs_clarification（EFFECT_TARGET_UNRESOLVED）；H02 虽通过识别检查，纯编译仍为 blocked（INTENT_AMBIGUOUS、PROHIBITION_NOT_ENFORCEABLE）。没有把这些结果写成业务可执行。H01/H11 的纯编译 applicable 也未验证提交执行。

L16 是最终候选中观察到的退步：对单独延续当前 EXECUTING 任务、没有追加要求的请求，模型输出一个 acknowledge 段、空效果；既定期望为 enqueue_follow_up，编译器返回 STATE_TRANSITION_INVALID。新增的延续/维持现状规则可能影响了该动作选择，但一次采样不足以确定因果。本轮没有改 L16 期望、改编译器或重跑该题以替换结果，也没有再改提示词。该问题留待监督复核；本轮不能宣布“无退步”或发布可用。

两轮探索共 11 次提供方调用，每个样本各 1 次，0 次脚本熔断冷却重试。部分 CLI 调用经历 WebSocket 连接错误后在同一次调用内切换 HTTPS，均获得有效语义输出，原始连接事件已留存；不能把这些连接事件描述成完全无传输问题。最终候选的 8 道相关开发题中 7 道检查通过、L16 失败，这只是探索记录，不是正式准确率。

## 最终冻结

冻结脚本 `tests/evaluation/capture-intent-r5-freeze.mjs` 已通过，证据在 `intent-codex-comparison-2026-10-20/r5-freeze/freeze.json` 和 `freeze-validation.log`。它核验全部探索题目覆盖、题集 SHA、预先报告的判分 SHA、每次最终候选所用源码/dist、实际 envelope 的 L0 总字符数与测量一致，并保存前后源码/dist 副本。离线测量还验证整个路由器源码和 dist 除这四条规则之外逐字一致。

| 文件 | SHA-256 |
| --- | --- |
| semantic-intent-router.service.ts | `a7214b47b90f1ff27f86cdfd8389abf9377523a01f042080fe5a8d0a046e93e9` |
| dist semantic-intent-router.service.js | `e03c15c59939dfcc6d4c1eaa1df1c77b6f21ac429b7658f83d4a642e0e906806` |
| 判分 run-intent-codex-current.mjs | `beec4dae26002278cee6572df09d15585432e466a6ae962ff6dfd60b16fc714a` |

本轮已停止模型运行。未启动 R5-5 正式评测；下一步先由监督方复核 L16 退步及当前冻结版本，再按用户决定处理。若后续需要进一步修改提示词，必须重新形成候选及冻结哈希，并继续等待新留出集和正式运行授权。

## 已知边界

新链路默认关闭，本轮没有修改开关、默认配置或 `.env`。提交层对 resume、replan、retry_failed_step、非测试 enqueue_follow_up 仍缺执行器；**纯编译 applicable 不等于提交执行成功**。提示词描述的原已批准计划绑定是设计责任，不表示本轮已经实现恢复执行器。

本轮不修改编译器、效果范围解析器、提交层、执行器或工作流，不做正式评测。开发探索不能证明泛化准确率或多次采样稳定性。冻结后等待监督方新留出集及用户的下一轮正式评测授权。
