# 已提交纯回答计划的执行与原子发布

日期：2026-10-19。对应 IRC-R01/R03/R07/R11/R12/R13、IR05/IR06/IR09 的部分实现。前置记录：[计划提交](plan-commit-report.md)。完整入口和阶段门未完成。

## 实现

新增 `IntentAnswerExecutorService`，注册到 MessageRoutingModule。计划提交事务完成后才调度 queued 的 answer_in_chat；启动时扫描未完成的回答步骤恢复。执行器使用原 Session、消息、快照、不可变计划和当前执行版本，不创建 WorkItem、AgentTask 或 Brief，也不改变业务 admission、generation 或暂停状态。

新增 `response` 准入及 `user_message_response` 阶段。分类仍独立使用 routing；business 保持原生命周期限制。response 必须绑定当前有效、正在执行且租约有效的 answer step，只能使用 Generic LLM/mock、agent_message 合同、纯 answer scope、空工具和 writeMode=none。调用解析、LogicalOperation 预约、Runtime 启动及结果审计均重验边界，停止未确认/删除/epoch 或 generation 失配不允许新模型调用。没有 effectScope 的版本化调用被拒绝；传入的 scope 内容还须与保存计划完全一致，不能仅复制 scopeHash 后替换效果。

step 的处理状态保存 owner、lease、总 deadline、attempts、当前 invocation、修复反馈、Retry-After 和待发布结果。默认总时间 120 秒、最多两次调用；一次格式修复与瞬时重试共用该预算。Generic LLM 对 response 不在单次 invocation 内再做隐式格式修复。认证/配置失败不反复调用；超出总时限的 Retry-After 不安排新请求；未结束的旧 operation 保留为 reconciliation_required。

仅接受 messageKind=answer、无 Agent/Task 转交目标、长度有界的输出。Prompt 只包含原消息、按上下文策略筛选的有效决定和显式选中制品的有限摘要；没有文件访问，不能声称检查过未提供的代码。正文/附件内容不能授予新权限。

先持久化待发布结果，再在同一事务内重验版本并追加唯一回复事件、Outbox、step.completed 与 actionStatus.applied。保存失败继续保留结果和处理预算，重启恢复不会再调用模型生成同一份回复。纠错 hold、版本变化、删除或 generation 变化之后到达的回答不会发布。回复发布本身不启动下一业务步骤。

系统设计 4.3 与 Plan 已补充 response 的约束；Harness 仅更新既有参考映射中的新阶段，没有新增 Harness 产品功能。

## 验证范围

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| Server 全量 | 2022 通过 + 7 开发脚本通过，0 失败，21 PostgreSQL 跳过 | `answer-executor-server-tests.log` |
| Shared 全量 | 280 通过 | `answer-executor-shared-tests.log` |
| 相关六个 spec | 118 通过 | `answer-executor-complete-regression.log` |
| File 重载恢复及执行器用例 | 10 通过 | `answer-executor-restart-tests.log` |
| 最终处理状态/CAS 增量 | 24 通过 | `answer-executor-final-status-tests.log` |
| 全仓类型检查 | 退出码 0 | `answer-executor-workspace-typecheck-final.log` |
| 后端最终测试类型检查 | 退出码 0 | `answer-executor-final-typecheck.log` |
| 后端构建 | 退出码 0 | `answer-executor-complete-build.log` |
| Harness | 退出码 0 | `answer-executor-harness-complete.log` |
| 实际 Nest/Generic LLM HTTP | SP01–SP04、PC01–PC03、AP01–AP03，10 项通过 | `answer-executor-runtime-final.log`、`answer-executor-runtime-results.json` |

各范围重叠，不累加为独立语义题目。全量 Server 之后新增了提交后调度、Retry-After、运行中到期等测试及对应终态处理；118 项回归和构建覆盖这些增量。随后进一步加强 File 重载恢复测试，并为 applying 状态补齐 routingRevision/updatedAt，分别由 10 项恢复测试和最终 24 项提交/回答回归覆盖；不能把前面的全量/Runtime 日志称为最后这处状态计数改动后的重跑。本次未运行全仓测试、完整前端构建或真实客户端。

AP01：同一回答第一次返回非法合同，第二次带具体修复反馈和原 sourceEventId；两次请求都没有 tools，最终只保存一条实际回复。

AP02：真实 Runtime operation 使用 response、两次 attempt，deadline 等于 step 持久化 deadline，无 taskId/workItemId；Session 仍 PAUSED，业务 admission 仍 closed。

AP03：重放已完成 step，模型请求计数不变，回复事件仍只有一条。

该 HTTP 验证使用完整 Nest 模块图、真实 Generic LLM 适配器与确定性 localhost provider。脚本显式驱动执行器以分开验证“提交”和“回答”；提交后自动调度时机另有事务测试。**入口不是 Sessions 首轮 API，模型输出为 fixture，不是准确率或真实用户问答质量评测。**

## 失败与修复记录

- `answer-executor-typecheck.log` / `answer-executor-workspace-typecheck.log`：内部错误处理初始误用了不完整的 AgentRunResult，以及不允许的 null 输出；改为只消费所需字段的内部结果类型。
- `answer-executor-regression.log`：新增 guard 抢先改变了旧 generation 检查的稳定错误码；将它移至已有生命周期检查之后，保留旧断言，115 项重新通过。
- `answer-executor-harness.log` / `answer-executor-harness-final.log`：新 phase 尚未出现在既有编排与上下文参考表；同步所有相关阶段表后完整 Harness 通过。

## 未完成

生产 `SessionsService.create/processIntentRouting` 仍走旧主链，首轮预建 WorkItem/Brief 尚未迁移；本次完成的是新计划已有消费者这一依赖。下一步必须在新的统一入口中先持久化原消息/路由，待合法计划提交后分别处理回答、澄清、任务创建及受控业务执行，且覆盖 source ready、恢复与特殊消息入口。

工作区读取型回答、测试/源码/产物执行器、执行型纠错、结构化多目标澄清、全部业务投影与晚到回调、PostgreSQL/CLI/双端故障矩阵、58 场景、500+ 双人标注以及灰度/发布仍未完成。ordered_plan 未启用。没有提交、部署或修改用户模型连接。完整目标保持进行中，证据指纹见 `answer-executor-manifest.json`。
