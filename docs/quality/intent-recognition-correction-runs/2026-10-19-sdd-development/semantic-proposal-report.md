# 新语义合同分类状态机与单层修复预算

日期：2026-10-19。对应 IR03.3、IR04、IR06、IR13.1 的实施增量；完整阶段门未通过。前置记录：[普通聊天纠错](chat-correction-report.md)。

## 本次实现

新增 `IntentUnderstandingRoutingService`，在现有 Nest 模块中注册。它直接使用持久化 Session、原 user_message、snapshot 和路由租约，通过现有无工具 Runtime 生成完整 `intent_understanding@1.0` 提案。提案、修复反馈、Retry-After、调用次数、deadline、epoch/generation 保存在原路由；模型提案未转换为旧宽泛动作，也不自动创建 WorkItem 或派发业务。

分类成功停在 VALIDATING，后续仍须由服务端编译器及提交事务裁决。状态机重验同会话来源、原文、租约、快照指纹及生命周期；并发服务实例只有一个获得调用权，旧 worker 无法认领、预约或通过旧路由应用接口消费新合同。已有旧合同调用的路由不能原地换合同并重置预算。

格式修复反馈有界持久化（原输出最多 8000 字符、错误最多 20 条、单条最多 500 字符）；反馈恢复、一次快照重建和瞬时重试共享原调用预算。语义提案完整保存，包括多个 segment；该保存不表示 ordered_plan 已启用或效果得到授权。认证、配置和停止未知失败即使传输标为 retryable，也不重复调用。

真实 Runtime 验证发现 Generic LLM 原先会在同一 invocation 内自行做一次格式修复，随后上层还可能继续修复。现对 routing admission 下的两种意图合同关闭适配器内格式修复，返回经过脱敏的有界诊断，由分类器持有唯一修复预算；其他业务合同沿用原适配器行为。新旧分类器均消费该诊断，避免把格式错误误作模型连接错误。

Runtime LogicalOperation 新增服务器传入的绝对 deadline ceiling，创建时取阶段/父操作/该 ceiling 的最小值，重试仅可收紧；暂停与恢复不能延长该时间。新提案和纠错复核都传递持久化 deadline。原聊天分类操作可能比其路由 deadline 晚初始化数毫秒，子纠错现在受更早的账本 deadline 约束，不仅受父 operation 上限约束。

纠错 planner 另补齐 repairFeedback 的持久化和退出前取消检查，工作实例在错误返回后中断，新实例仍携带具体错误使用最后一次调用，不恢复已消耗次数。

## 实际检查

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 相关回归（8 个 spec） | 155 通过，0 失败 | `semantic-proposal-complete-regression.log` |
| `npm run test --workspace @agent-cluster/server` | 2000 业务测试 + 7 开发脚本通过；21 PostgreSQL 跳过 | `semantic-proposal-server-tests.log` |
| 全仓 typecheck | 退出码 0 | `semantic-proposal-workspace-typecheck-final.log` |
| 最终 server build | 退出码 0 | `semantic-proposal-complete-build.log` |
| Harness | 退出码 0 | `semantic-proposal-harness.log` |
| 实际 Nest + Generic LLM HTTP | SP01–SP04 四项通过 | `semantic-proposal-runtime-final.log`、`semantic-proposal-runtime-results.json` |
| 既有聊天纠错 API 回归 | CC01–CC07 七项通过 | `semantic-proposal-chat-http-final.log`、`semantic-proposal-chat-http-results.json` |

相关回归包含在服务器全量中，不能相加为独立样本。本次未重跑全仓测试/前端构建，没有前端实现变化；全部类型检查覆盖新增可选共享字段。前次全仓 2890 的结果保留为历史范围，不冒充本次全仓测试。

SP01：本机 provider 首次返回非法结构；分类器保存错误并发起唯一一次修复。两次请求均为新合同、携带原 sourceEventId、无工具；第二次确实含修复反馈，分类次数为 2。

SP02：实际 LogicalOperation 的 attemptsUsed 为 2，outputContractKey 为 `intent_understanding@1.0`；operation.deadlineAt、deadlineCeilingAt 和路由 deadline 完全一致。

SP03：实际持久化 Session 仍 PAUSED、业务 admission 仍 closed，没有 WorkItem，也没有业务 LogicalOperation。

SP04：重放已保存提案，routingRevision 不变，模型请求总数仍为 2。

SP 场景使用完整 Nest 模块图及实际 Runtime 调用，但入口是直接调用分类服务，**不是 Sessions 首轮 API**。CC 场景使用真正 messages/corrections API、File backend、后端进程重启，验证已有连续纠错未回归。两组模型响应均为确定性本机 fixture，不能作为真实模型准确率。

## 失败记录

- `semantic-proposal-typecheck.log`：初始 `operationPolicy` 引用位置错误，改为现有 LogicalOperationStore 导出。
- `semantic-proposal-tests.log`：新增 fixture 的事件缺少 metadata；补齐正常事件合同后全部通过。
- `semantic-proposal-runtime.log`：最初 SP01 发现实际 HTTP 两次、账本一次，触发本次适配器修复归属调整；未放宽断言。
- `semantic-proposal-chat-http.log`：与全量测试并行时，本机 provider 的启动可用性检查超时，Runtime 判 unavailable，消息 BLOCKED，模型请求为零。保留失败日志；待所有进程终结后使用同一最终构建独立重跑通过，未扩大生产超时或绕过准入。

## 尚未完成与下一接点

新服务已注册并通过实际 Runtime 验证，生产 `SessionsService.create/processIntentRouting` **尚未调用它**；首轮仍走旧的预建 WorkItem/Brief 路径。不能据此宣称 IRC-R01、G2 或 IR06.1 完成。

下一接点是把新提案交给持久化计划编译/提交服务，绑定实际授权和有限动作，再改首轮/后续入口；应同时延后 WorkItem/Brief 创建，而不能把新合同降级为旧 `continue_active_work_item`。确定性命令和已有纠错状态机继续复用。无 WorkItem 问答的实际回复、受限测试/产物/源码执行器、执行型纠错、全部投影事务、真实 PostgreSQL/CLI/Electron、独立标注评测及发布门仍待完成。ordered_plan 未启用。

本次没有提交、发布、部署或更换用户模型连接。源代码与证据指纹见 `semantic-proposal-manifest.json`；整个目标保持进行中。
