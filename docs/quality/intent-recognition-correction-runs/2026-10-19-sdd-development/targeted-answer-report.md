# 指定 Agent 回答开发记录

Run ID：`SDD-2026-10-20-targeted-answer`。依据四件套及 IRC-AC06/13/20，补齐 IR04/IR06/IR09 的单段多目标回答；完整专项仍在实施中。

## 已实现行为

用户向多个 Agent 提出同一个问题时，纯编译器保留原语义段和证据，为每个目标创建独立 step。显式 @ 目标既不能遗漏，也不能被模型扩充。计划提交事务一次保存全部 step 和不可变版本，提交失败时无派发。多段意图依然进入澄清，不启用 ordered_plan。

回答执行器选择 step 的唯一 Agent，不可用时明确失败；Runtime 启动前重新核验实际 Agent 身份。每步保留独立幂等身份、租约、两次有限预算与绝对截止时间。会话暂停不因回答而恢复，无隐式 WorkItem/Brief。已有只读效果约束不扩大。

全部目标完成才将路由标为 applied；任何目标失败保留 failed，其他成功回答继续保留。回复与 Outbox 原子发布，带原问题、版本、步骤、调用及实际回答者身份。失败事件带目标和原消息，支持客户端定位。保存后发布失败可从持久结果补发，不重新调用模型。

## 验证结果

| 范围 | 结果与证据 |
| --- | --- |
| 服务端完整回归 | 2162 + 7 通过，0 失败，37 条件跳过；`targeted-answer-server-tests.log` |
| 实际 HTTP/File | 5/5；`targeted-answer-http-final.log` 与 `targeted-answer-http-results.json` |
| 独立 PostgreSQL 16.13 | 34/34，0 失败、0 跳过；`targeted-answer-postgres.log/.json` |
| 全仓类型检查 | 通过；`targeted-answer-typecheck-final.log` |
| 最终服务端构建 | 通过；`targeted-answer-build-complete.log` |

服务端完整回归已包含本轮 8 个新增本地测试：全部目标完成、部分失败、目标不可用、并发领取和身份校验、纠错屏障、结果补发、目标展开及全部 step 原子提交。该回归之后增加 2 个 PostgreSQL 条件测试，并在真实临时数据库单独运行；常规全量运行中的 32 个 PostgreSQL 跳过已有本次独立运行证据，另 5 个可选 Docker 执行器测试本轮未重跑。计数互有重叠，不相加成独立用例总数。

HTTP 使用实际 Nest 服务、Generic LLM 适配器、localhost 确定性供应商和独立 File 数据。TA01/TA02 验证双目标各产生一条实际 Agent 回复、工具为空、模型共调用三次（识别一次、回答两次）；TA03 原 HTTP 请求重放零新增调用；TA04 一位 Agent 返回 401 时另一位仍完成且路由保持失败；TA05 杀停并重启实际服务后状态保留、无重复调用。前置会话建立调用不计入目标消息的三次。

数据库新增用例使用独立 Persistence 连接竞争同一提交和每个目标的执行。仅一个调用取得有效 step，每个 Agent 调用一次；重载后回复/Outbox 唯一、部分失败聚合不丢失。SQL trigger 注入 step 插入异常，验证所有 step、版本和提交事件回滚、无调度。测试在新建本地容器运行，迁移 23 项存在、故障 trigger 清理完毕，结束后容器删除；不连接生产数据库。

## 失败与修正

初始类型检查发现 RuntimePreference 空对象推断不足；添加明确合同类型。File 重启测试最初错误地同时使用旧缓存 writer 和新实例，调整为真实单 writer 停止/恢复顺序；未改动全局 File 一致性策略。新 PostgreSQL 夹具最初直接赋值只读 agentIds 字段，改为沿用合同允许的数组构造方式；最终全仓类型检查通过。早期失败日志保留，文件名与最终证据分开。

## 未完成验收

本轮修改后未再运行整个工作区的所有测试：业务修改集中在服务端，执行服务端完整回归、全仓类型检查和实际 HTTP/数据库验证。较早的全仓结果不代替本轮最终源码结果。补充 Harness 和 diff 检查结果记录在 manifest。

固定供应商输出只能验证工程行为，不能证明真实模型准确率。数据库为服务级集成，并非 PostgreSQL HTTP 崩溃矩阵；File 仅承诺单 writer，不宣称多个进程共享文件一致性。尚未完成真实 Web/Desktop/Electron/SSE、Agent 删除过程中权限变化的完整矩阵、全部 58 场景、独立 500+ 双人标注和三轮模型评测、通用 Brief/源码/外部效果及发布门。目标失败的自动替代、无授权重跑和多段自动执行均未开放。整组任务和阶段门不勾选；未提交、部署或修改个人模型配置。

后续入口核查：`SessionsService.generateBriefInBackground` 对新合同直接返回；`assertIntentExecutionCurrent` 对新合同缺少 executionBinding 的业务调用拒绝。旧 `OrchestratorService.discussAndCreateBrief` 包含讨论事件、模型调用和旧 Map 发布，不能仅去掉入口守卫后复用。下一个 Brief 切片应定义独立的派生步骤、受限 Runtime 配置及版本绑定，再实现 Brief/建议任务/确认事件的原子发布与恢复；创建 WorkItem 的 completed 步骤本身不代表授权生成 Brief。这些依赖尚未实施，保留 IR06 未完成状态。
