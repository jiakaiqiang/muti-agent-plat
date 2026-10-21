# R5-1 设计门核查：resume 效果声明尚未明确

> 后续决定（2026-10-20）：用户已明确采用 A，设计门已解除。以下保留当时核查记录；本轮实施、验证和冻结记录见 [R5 冻结报告](intent-codex-r5-freeze-2026-10-20.md)。

日期：2026-10-20。目标架构为 intent-understanding-v1。本次仅核查设计依据；未修改产品代码、提示词、开发集题目或判分，未启动模型探索或正式评测。上一轮 report.md 的实测结论保持不变。

## 原文依据

1. [Spec IRC-R03](../product/intent-recognition-correction-spec-v1.md:61)：

   > 回答/读取、产物写入、源码修改、测试、命令和外部写入分别授权；否定有对象与范围。既有授权可在有效范围内复用，子任务不得扩权，Runtime 不能约束时阻断。

2. [Spec IRC-R02](../product/intent-recognition-correction-spec-v1.md:60)：

   > 语义输出包含分段目标、对话行为、需求关系、目标、效果、禁止项、原文证据、缺失项和依赖。模型仅提交提案，服务端形成有限动作计划。

3. [Plan D04](../design/intent-recognition-correction-plan-v1.md:82)：

   > validUserGrant 与阶段/工具/工作区/Runtime 能力求交并减去禁止项；传到实际 Adapter/工具/写回层

4. [Plan 第 4 节](../design/intent-recognition-correction-plan-v1.md:90)：

   > 完整字段、动作允许矩阵和错误码沿用系统开发设计第 4–11 节，实施不能省略其负向条件。本 Plan 组织开发依赖，不重新发明一套合同。

因此继续检查被引用的详细设计，而不是从当前实现倒推规范：

5. [详细设计 §6.3](../design/intent-recognition-correction-system-development-design-v1.md:331) 的状态矩阵：

   > PAUSED，停止已确认 | resume；使用已有有效授权 | 不能恢复已取消或已被新版本废弃的任务

6. [详细设计 §5.3](../design/intent-recognition-correction-system-development-design-v1.md:245)：

   > `validUserGrant` 可以来自当前经过验证的明确请求，也可以来自仍有效、未撤销且目标范围匹配的历史授权；不要求每个低风险动作重新弹卡。模型的 requestedEffects、riskLevel、confidence 和 Agent Profile 都不能单独成为 grant。

## 能确定与不能确定的内容

能确定：resume 可使用仍有效、未撤销且范围匹配的历史授权；模型效果提案不等于授权；恢复不得扩权，也不能恢复已取消或已废弃任务。

不能确定：上述条文没有规定 resume 的 requestedEffects 必须为空，也没有规定必须重述原计划效果。**“复用历史授权”与“本条语义是否重新声明效果”是两个不同问题。** 两种输出都可以在服务端复核历史授权，因此仅凭这些条文不能选择其中一种。

## 待明确的两种解释

| 解释 | 模型输出与服务端责任 | H01/H11 及评测影响 |
|---|---|---|
| A：恢复原已批准计划，不声明新效果 | 单纯恢复时 requestedEffects=[]；服务端绑定原已批准计划，并验证原效果范围、授权有效性、版本和停止状态。空数组本身不能授权恢复执行。 | 可据明确规范修改提示词，保留识别/纯编译层的 resume 正例检查。但当前夹具未提供完整原执行计划，不能将纯编译通过称为端到端恢复成功；提交层无执行器仍然阻断。 |
| B：恢复消息重述待恢复效果，由服务端重新校验 | requestedEffects 声明恢复所需效果；授权仍可复用历史 grant，并非每次必须向用户重新申请。缺少资源或计划依据时应澄清/阻断。 | 当前空资源夹具不足以要求 positiveResumeApplicable 必然通过。应调整判分或先补齐合法资源/原计划夹具，预先冻结新口径；不能为提高分数让模型省略应声明的效果。 |

两者均不能靠提示词填补提交层 resume/replan/retry_failed_step/非测试 enqueue_follow_up 缺执行器的问题。本轮不会实现这些执行器。

## 按 R5-1 停止，尚未进入 R5-2～R5-4

[第五轮要求 R5-1](intent-codex-supervisor-review-2026-10-20.md) 明确要求：

> 若 Spec 没写清：停下来，在报告里列出两种解释和影响，不要自己选。

因此未自行选择 A/B，未修改恢复提示词或 positiveResumeApplicable 判分。H03 的通用拆分规则、提示词压缩、开发集探索、定向测试、server typecheck/build 和新构建冻结均未开始。没有创建或读取新留出集。

提示词本轮无修改，净增为 0；不产生新的 L0/B01 预算测量或模型成绩。上一轮 B01 的 7552→8412 是历史实测，不能标成本轮验证。本轮没有运行测试或构建，因为设计前置条件尚未明确且只有本说明文档发生变更。

下一步需要明确：单纯恢复原计划时，是否规定 requestedEffects=[] 并绑定原计划，还是必须重述效果并由服务端复核历史授权。明确后才能按对应分支继续 R5-2～R5-4。

当前文件实读 SHA-256（沿用上一轮，不是本轮新构建冻结）：

- semantic-intent-router.service.ts：`8abc792ae92b062ca8bdf1f738c819184a4007de8823b2376caf5c0c15f5a821`
- dist semantic-intent-router.service.js：`5d3586dc10f1957c7ed2f3b876acc26e8d61aebd4e26ff8a27bfc21d959bcab2`
