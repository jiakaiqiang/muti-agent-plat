# 新语义计划的事务提交

日期：2026-10-19。对应 IR04、IR05、IR06.3、IR07 和 IR11 基础的部分实现。前置记录：[语义提案与修复预算](semantic-proposal-report.md)。完整阶段门仍未通过。

## 实现结果

新增并注册 `IntentPlanCommitService`。调用方只能提交 Session、routing、actor 和预期 routingRevision；计划、原文、授权及候选引用都从服务器持久化数据读取。在同一事务内重验 owner、epoch/generation、hold、来源事件、快照业务指纹和 CAS，再编译并保存不可变 IntentRouteRevision、step、状态事件及 Outbox。重放返回相同 planId；并发只有一次提交，磁盘失败全部回滚。

当前支持的事务内动作：创建初始/关联/独立任务上下文、记录需求信息、记录约束。创建任务上下文不生成 Brief、不启动业务、不自动恢复暂停。关联任务只继承选中的有效 Decision 和父任务拥有或已继承的制品。目标仍有执行时，约束/信息更新被阻断；成功更新同时递增 requirementRevision 与 executionEpoch，防止旧的无版本排队调用继续执行。

纯回答保存为 queued step，routing.actionStatus 为 pending，不创建 WorkItem；尚未执行回答。其他执行动作仍 blocked，纠错转交已有版本化纠错入口的边界仍保留。多段完整保存于澄清计划与事件，不执行部分分段。ordered_plan 未启用。

快照新增最多 16 个制品候选，标题最多 200 字符、摘要最多 400 字符，并记录遗漏数。候选必须同 Session/epoch 且属于候选任务或其继承集合；提交再与当前存储交叉检查。快照之后新增、已删除、其他会话/epoch、父任务范围之外的制品不能被继承。提示词包含这些候选；旧快照缺少候选时不授予制品继承权限。

无当前消息证据的执行计划被拒绝。Decision hash 根据 clean/selected/confirmed 上下文策略计算，事务修改后绑定实际目标的有效 Decision 集。新版本只保存有效 scope 实际引用的 grant，未使用的父任务授权不会自动复制。执行守卫也要求版本的计划 outcome 为 applicable。

enforce 结果会移除对应旧 pending follow-up，防止旧 Coordinator 消费新合同。shadow 仅保存评估计划和路由审计，不创建任务/step/version/业务事件，不消费旧 follow-up。Web/Desktop 共用事件 Store 将三种计划状态显示为系统消息，明确“已保存计划”与“已执行”的差别。

## 实际验证

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| 后端完整测试 | 2013 通过，0 失败；21 PostgreSQL 跳过；另 7 开发脚本通过 | `plan-commit-server-tests.log` |
| 最终相关回归（提交、编译、纠错、LogicalOperation） | 51 通过，0 失败 | `plan-commit-epoch-regression.log` |
| Web 事件状态 | 13 通过 | `plan-commit-web-tests.log` |
| 全仓类型检查 | 退出码 0 | `plan-commit-workspace-typecheck-final.log` |
| 最终后端构建（含最后 guard/epoch 测试） | 退出码 0 | `plan-commit-epoch-build.log` |
| Harness | 退出码 0 | `plan-commit-harness.log` |
| Nest + Generic LLM 本地 HTTP | SP01–SP04、PC01–PC03，7 项通过 | `plan-commit-runtime-final.log`、`plan-commit-runtime-results.json` |

完整后端测试启动后新增了一项非 applicable 计划守卫测试，以及约束更新 epoch 保护。最终 51 项回归和后端构建覆盖这些增量；没有把 2013 当作最终全量重跑。相关测试有重叠，不能相加为独立语义评测题数。本次未运行全仓测试或前端完整构建。

PC01 验证实际新合同提案提交成 queued 回答计划，无 WorkItem，Session 保持 PAUSED，业务 admission 保持 closed；PC02 验证重放不重复调用模型或创建版本；PC03 验证两个并发提交只创建一个初始任务上下文，step 为 completed，但没有 Brief 或业务 operation。此前 SP 的两次 HTTP 请求、两次账本调用、同一绝对 deadline 和无工具断言保持通过。

这些场景使用实际 Nest 模块图、Generic LLM 适配器和确定性 localhost provider；入口为直接调用分类/提交服务，**不是 Sessions 首轮 API，也不是真实模型准确率评测**。数据库为隔离 File backend。

## 返工与边界

初始类型检查/构建发现测试夹具赋值只读字段，改用数组修改及对象构造，保留 `plan-commit-typecheck.log`、`plan-commit-workspace-typecheck.log`、`plan-commit-server-build.log`。未放宽合同。初始提交服务中父任务自身制品未列入继承范围、使用全库制品候选和复制所有父权限的问题在本轮复核中修正；越界/失效/新出现候选均有拒绝回归。

生产 `SessionsService.create/processIntentRouting` 仍没有切换到新服务。首轮仍预建 WorkItem/Brief，无 WorkItem 回答执行器尚未实现；本次仅补齐提交依赖，不将 IR06.1、IRC-AC01 或 G2 标为完成。后续必须接通受限回答调度与原子回复，然后迁移首轮/后续入口及恢复路径，避免排队计划无人消费或绕过旧业务准入。

受限测试/源码/产物执行器、执行型纠错、全部业务投影事务、真实 PostgreSQL/CLI/Electron、完整 58 场景、500+ 双人标注及灰度/回滚门仍待完成。未提交、发布、部署或修改用户模型连接。证据指纹见 `plan-commit-manifest.json`。
