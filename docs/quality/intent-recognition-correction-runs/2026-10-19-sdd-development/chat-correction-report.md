# 普通聊天纠错接入与连续版本验证

日期：2026-10-19。范围：IR03.3、IR06.3、IR08.1–IR08.4、IR09、IR10 的增量。前置记录：[客户端纠错入口](correction-ui-report.md)。本报告为局部交付，完整 G2/G3/G4 未通过。

## 实现行为

- enforce V2 普通消息识别到 correction 后，进入同一个 IntentCorrectionService 接收事务。原 user_message 作为纠错来源，不重复创建用户输入；原分类 follow-up 被消费，不再进入普通业务规划。
- 目标来自持久化快照中的旧 Decision 或明确 reply 引用，候选最多 8 条并记录遗漏。事务重验原文、来源、租约、路由 revision、Decision revision、目标 WorkItem、业务指纹和策略。歧义先澄清，不猜最近任务，不创建无关任务屏障。
- 接收、hold、epoch、原分类消费及事件/Outbox 原子提交；提交失败无半状态。旧缓存不能把已消费的 follow-up 恢复为 planning。通用关系确认和旧 RouteApplication 不得绕过版本纠错。
- 普通消息识别与纠错复核共享原两次调用总预算和 deadline；新 LogicalOperation 保留 parentOperationId。首轮已用两次时保留屏障并报告预算耗尽，不重新分配两次。
- 连续纠错保持原路由为规范目标。第二次修改上一条纠错生成的 Decision，追加原路由第三版；Web/Desktop 从纠错消息入口也查询原路由历史。API 拒绝把已消费的来源路由再次当作独立纠错目标。
- Session 活对象在读取/保存时吸收同 dataEpoch 下已提交的更高 decisionLedgerRevision，保留对象身份、单调更新版本。保存时只读取一次持久化 Session 集合。该保护不等于完成跨进程 Session 全部字段的事务化缓存同步。
- 无执行效果的约束纠正沿用已有激活事务：supersede/局部 override、新版本、计划步骤和 Outbox 一起提交。不会因纠错自动恢复业务执行。

## 实际验证

| 检查 | 结果与证据 |
| --- | --- |
| 全仓 `npm run test` | 2890 通过、0 失败、21 PostgreSQL 跳过；`chat-correction-workspace-tests-final.log`。发生在最终连续版本/缓存保护增量之前。 |
| 最终后端相关回归 | 250 通过、0 失败；`chat-correction-final-regression.log`。覆盖 correction/planner/context/semantic/sessions/runtime-invocation/logical-operation，包含最新增量。 |
| 全仓 typecheck | 退出码 0；`chat-correction-final-typecheck.log`。随后仅优化 Session 批量读取，最终 server build 和相关回归覆盖该变动。 |
| 全仓 build | 退出码 0；`chat-correction-workspace-build.log`。最终后端另见 `chat-correction-server-final-build.log`。 |
| Harness | 退出码 0；`chat-correction-harness-final.log`。 |
| 本机 HTTP | CC01–CC07 共 7 项通过；`chat-correction-http-results.json`、`chat-correction-http-current-build.log`。 |

相关回归和 HTTP 与全仓测试重叠，不能相加为独立样本。全仓内 Web 为 469 项、Server 为 1982 项，其他包及开发脚本共 439 项；这是该次全仓运行口径，后续新增用例只计入其单独的最终回归。

HTTP 使用真正的 `/sessions/:id/messages` 和 corrections API、独立 File 状态、真正后端进程重启、Generic LLM 到本机确定性 OpenAI 兼容服务的 HTTP 传输。模型结果由 fixture 固定，**不证明语义准确率**，未修改真实模型配置。

| 场景 | 输入/动作 | 实际结果 | 关联 |
| --- | --- | --- | --- |
| CC01 | 聊天“超时改为 30 分钟，原 10 分钟作废。” | 原事件复用，纠错处理中目标 hold 已持久化 | IR08.1/2，IRC-R09 |
| CC02 | 放行确定性语义复核 | 应用新版本；两次识别均无工具 | IR08.4，IC12 的激活部分 |
| CC03 | 检查识别调用账本 | 总次数 2，原 deadline 保留，子 operation 绑定原分类 | IR03.3，IRC-R12 |
| CC04 | 核对真实状态 | 10 分钟 superseded，30 分钟生效；来源 follow-up cancelled；未隐式恢复 | IR08.3/4，IC12 的账本部分 |
| CC07 | 再改为 45 分钟 | 两条纠错 applied，原路由共 3 个版本；4 次模型调用 | IR08.1/3，IRC-R09/10 |
| CC05 | “你理解错了”，无唯一旧目标 | CLARIFICATION_REQUIRED；不新增纠错，不额外复核 | IR08.1，IC18 |
| CC06 | 真实进程重启后重发原消息幂等键 | 返回同一来源；无额外模型调用 | IR09.3，IRC-R13 |

这些用例验证表中列出的断言，不覆盖 IC09 的运行中停止、IC16 的迟到写回或 IF07 的 hold 提交后崩溃。IC12 的后续实际 Brief/执行效果也未由该 HTTP fixture 验证。

## 失败与修复记录

- `chat-correction-http.log`：本机 provider readiness GET 被当作 JSON POST，产生 500。修复 fixture 的 readiness 响应。
- `chat-correction-http-provider-fixed.log`：fixture 中原路由停在 RECEIVED，队列按顺序阻止后续消息认领；将 fixture 原路由按合法状态转换置为 ROUTED。
- `chat-correction-workspace-tests.log`：文档组件测试在异步 WebCrypto 摘要完成前断言。仅改为 `vi.waitFor` 等待原断言满足，未删除断言；全仓重跑成功。
- 连续版本测试促使增加规范原路由引用与 Session ledger 版本刷新；最终 250 项回归和 7 项 HTTP 验证覆盖该增量。初次 6 项 HTTP 输出保留在对应历史日志。

## 剩余边界

新语义合同尚未成为首轮/后续全部入口的主分类合同；当前普通聊天接入是旧 V2 classification 到新 correction planner 的迁移桥接。旧特殊 EXECUTING scope-change 分支和禁用 routing 的路径尚未统一。无唯一目标时提供回复原消息/面板选目标提示，没有完整结构化目标澄清会话。

执行型纠错派发、测试/源码/产物受限执行器、全部业务投影事务和全路径迟到回调仍未完成。真实 PostgreSQL、CLI、Electron 双端/SSE 故障矩阵、58 场景、独立 500+ 双人标注和发布门仍未验证。ordered_plan 保持未启用。

IR08/IR10 整项及完整 AC 均保持不勾选。未提交、发布或部署。源码、文档和日志指纹见 `chat-correction-manifest.json`，原始 dirty 基线见 `baseline-manifest.json`。
