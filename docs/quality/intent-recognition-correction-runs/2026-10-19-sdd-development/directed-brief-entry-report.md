# 指定 Agent 修订入口与执行增量

Run ID：SDD-2026-10-20-directed-brief-entry。当前是完整 SDD 的增量，不代表全部开发或验收完成。

## 已实现

结构化修订请求支持最多 8 个唯一 assignedAgentKeys，仍绑定原卡片、Brief 版本、意图版本和数据 epoch。受理时按当前可用目录和会话成员解析固定 ID；原始选择和解析结果持久化。模型不能替换审阅名单。客户端在响应不确定时冻结原名单，重试与响应核对均包含名单。

每位审阅者有独立 review_brief 步骤、调用身份、租约和有限预算，使用 brief_revision/agent_message 合同，不授予工具或工作区能力。Generic adapter 不再内嵌修复调用，统一由持久化执行器控制最多两次调用。成功意见原子写入事件及 Outbox，不变成确认 Decision。仅失败目标可以通过已有显式重试 API 创建新操作，成功者不重复调用。

定稿必须等待全部精确绑定意见。普通纠错生成只使用有效约束；旧草稿仅提供给指定审阅及其汇总流程，并明确标注为非权威内容。移出会话的目标在执行守卫中失效。生成新稿后仍需用户确认，不自动执行建议任务。

## 验证与证据

- 最终服务层入口/执行回归：40/40（directed-brief-entry-verified.log）；后续将一个时间敏感测试改为调用后推进时钟，由最终 Server 回归覆盖。
- Generic adapter 和共享运行策略：49/49（directed-brief-runtime-tests.log）。
- Web 全量：539/539（directed-brief-web-regression.log），包含共享 Store 的名单冻结及回执替换拒绝。
- 实际 Nest/Sessions HTTP + Generic LLM + File：7/7（directed-brief-http-results.json），覆盖并发受理、暂停不消耗生成预算、两名固定审阅者、空工具、新稿确认、真实服务重启及幂等回放。
- 工作区 typecheck、Shared/Server/Web build、Harness 均已通过。最终 Server 类型检查也通过，覆盖最后新增测试和时间夹具调整。
- 后端全量最终 2223 项通过、41 项条件跳过，另有 7 项开发脚本测试通过（directed-brief-server-final.log）；第一次失败日志保留供审计。

## 发现并修正的问题

初次执行器测试卡住及有界重跑超时，保留 directed-brief-executor-tests.log 和 directed-brief-executor-bounded.log。旧草稿被无条件加入普通纠错上下文，违反“旧约束不回流”断言；限定上下文后 37 项全部通过。新增入口测试曾错误构造 agent_message，触发真实的第二次格式修复，修正夹具后 40 项通过。全量测试首次发现 30 ms 的预算可能在繁忙机器上于调用前到期；改为实际调用进入后推进时钟，准确测试迟到结果，而不依赖机器速度。未放宽生产预算或断言。

## 尚未覆盖

这轮 HTTP 使用本地确定性 provider，不是自然语言准确率评测。未新增指定审阅的真实 PostgreSQL 跨连接、浏览器/Electron/SSE、运行中崩溃矩阵。失败恢复面板仍沿用草稿生成文案，需补齐逐目标名称和状态展示。专业工作流、复杂澄清及完整多段执行仍未完成；ordered_plan 仍关闭。500+ 独立双人标注、真实模型多轮评测及发布门禁仍待完成。未提交、部署或修改生产模型连接。
