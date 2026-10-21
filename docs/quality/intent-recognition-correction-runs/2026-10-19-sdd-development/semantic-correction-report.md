# 新合同普通消息的版本化纠错

日期：2026-10-19。对应 IR06/IR08/IR09 的部分实现，前置为[新 Sessions 入口](semantic-ingress-report.md)。完整阶段门未完成。

## 代码行为

新入口的 correction/correct_route 提案进入现有 IntentCorrectionService，在接收事务内重新编译并检查源消息、epoch/generation、业务快照、唯一目标、原路由版本、旧 Decision revision 和原文证据。新消息不需要创建旧 follow-up；存储不变量只对已固定新合同的 Session/来源路由允许该形式，旧合同仍要求真实 follow-up 绑定。

快照候选增加合法已提交计划的 WorkItem 和源 Decision 所属任务。连续纠正可以引用上一条纠正消息，但始终归到原路由。纠错接受后复用旧事务的 hold、epoch、定向停止、queued step 失效和不可变历史。影响范围从原有效版本的计划读取，不只依赖旧 handlingPlan/follow-up。

识别与纠错复核共享原始两次调用和总 deadline，接收时携带 attempts、repair 与 rebuild 计数，不重置预算。没有运行中效果时，由已有 planner 复核后原子替换 Decision、更新有效版本和释放自身 hold。不自动恢复会话或启动 Brief。旧效果仍在运行时继续保持停止/对账状态，不声称已回滚。最初分类已耗尽预算时仍不能另开自动调用。

非唯一或不合法目标先给定位提示，不修改旧约束。存储失败保留已保存提案，重试接受事务时不重新识别。相同消息重放复用 correction，迟到来源不能重新执行旧队列。

## 已执行的验证

最终 Server 全量 `semantic-correction-server-tests.log`：2037 项通过、7 项开发脚本通过、0 失败、21 PostgreSQL 跳过。全仓类型检查 `semantic-correction-workspace-typecheck.log`、Harness `semantic-correction-harness.log` 与 `semantic-correction-diff-check.log` 均退出码 0。该全量覆盖本次最终代码；没有重跑 Web/Desktop 全量测试或真实客户端交互。

相关回归 `semantic-correction-regression.log`：87 项通过，覆盖新入口、旧聊天纠错、planner、Context 和恢复。包含新合同连续 10→30→45 分钟、原事件复用、无旧队列、幂等、伪造目标、接受时旧 Decision revision 变化、写盘回滚后复用原提案。

最终后端构建 `semantic-correction-build-final.log` 退出码 0。实际 Sessions API/进程重启/Generic LLM localhost 检查 `semantic-correction-http-final.log` 与 `semantic-correction-http-results.json`：11 项通过，含原 IN01–IN07 和以下增量：

| 用例 | 实际观察 |
| --- | --- |
| SC01 | 新合同约束纠正，两次 HTTP 模型调用，processing.attemptsUsed=2，version=2，旧 Decision superseded，无 Brief，hold 释放 |
| SC02 | 同键同内容重发原路由，新增调用 0，correction 仍 1 条 |
| SC03 | 30→45 分钟继续更新同一原路由，version=3，仅一条有效约束，无旧 follow-up |
| SC04 | 伪造 correctionOfRoutingId 只调用一次后澄清；没有新增 correction/hold，原有效 Decision 保留 |

测试输出是确定性 fixture，仅证明工程路径，不代表语义准确率或生产模型质量。各测试范围重叠，不能相加为独立题目。

## 失败记录与修复

- 初始回归的 INTENT_RECORD_CHAT_BINDING_MISMATCH 暴露旧存储约束强制 follow-up；现按固定语义合同区分来源，未放宽旧合同约束。
- 初始类型检查发现测试修改只读 target 字段；改为构造替代对象。
- 首次 HTTP 把 401 注入放在纠错之前，触发真实 Generic LLM 熔断，后续约束消息被 MODEL_ERROR 阻止；将故障注入放在最后，不绕过或清除产品熔断。失败日志 semantic-correction-http.log 保留。

## 尚未完成

本次只接单段、明确目标、无执行效果纠错。结构化多目标澄清、指定 Agent 回答、实际受限执行器/Brief 调度、全部特殊入口、业务投影/迟到回调矩阵仍未完成。真实 PostgreSQL、CLI、Web/Electron、独立双人标注、完整 58 场景及发布门仍缺证据。旧合同与新合同混合迁移、ordered_plan、生产放量均未完成或未启用；没有提交、部署或修改真实模型连接。IR06、IR08 与完整 G2/G3 保持未勾选。
