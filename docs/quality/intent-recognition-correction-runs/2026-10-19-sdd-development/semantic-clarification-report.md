# 新语义合同结构化澄清开发与验证

Run ID：`SDD-2026-10-20-semantic-clarification`。状态：本增量完成，整个意图专项继续实施。

依据：Spec IRC-R08/13/16、Plan 的结构化确认及事务提交设计、Task IR02/IR03/IR06、Checklist 对应确认与重试检查，以及系统开发设计第 8.2 节。沿用项目地图与 Harness 工程规程。没有提交、部署或修改生产连接。

## 实现结果

新合同先前只能发出澄清文本，原确认 API 又依赖旧 follow-up/活动 WorkItem。本增量让首轮没有 WorkItem 的新语义消息也能生成可操作的关系卡，并通过现有 `/sessions/:sessionId/message-routings/:routingId/clarify` 接口提交。

- 卡片绑定原消息、会话、data epoch、generation、routing revision、有效期和业务快照。有当前任务时提供三种关系；没有当前任务时仅提供独立任务选项。
- 关系选择只确定任务关系。相关任务仅继承卡片展示的已选约束/产物；不会默认继承全部旧约束。独立任务不携带旧任务上下文。
- 服务端重新理解原消息，同时将结构化选择作为绑定上下文。模型不能改选另一关系、添加执行效果种类、删除原禁止项，或把选择解释为恢复执行授权。
- 模型处理状态、租约、调用次数、快照、修复反馈和截止时间持久化。每次明确的用户关系选择是新的逻辑操作，最多 2 次模型调用、1 次 schema 修复、120 秒总时限。重复请求及重启不重置该预算。它不与最初消息分类合计为 2 次；普通聊天纠错沿用原分类预算的规则不变。
- 认证/配置失败直接阻止；瞬态失败只在剩余预算内重试；失败产生阻止事件和 Outbox，不伪造“确认成功”。保留运行时结构化错误码，`NO_ELIGIBLE_RUNTIME` 正确归为配置错误。
- 最终事务一起保存原始不可执行版本、确认后的版本、适用的 WorkItem/Decision/step、确认收据、已解决事件及 Outbox。提交失败时无部分业务效果。相同选择重放返回结果，相反选择明确 409。
- 启动恢复可直接提交已保存的 ready 提案。过期租约及耗尽预算不能重新获得调用次数。会话 generation 变化后的迟到结果不能生成任务或解决卡片。
- 复用 Web/Desktop 已有的关系卡处理入口，保持 `intent_relation_clarification` reason 和路由版本绑定；本增量没有修改页面组件。API 成功明确返回 HTTP 200。

## 验证

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 相关四个服务套件 | 65 通过、0 失败 | `semantic-clarification-related-verified.log` |
| Server 全量 | 2113 通过、0 失败、26 跳过；开发脚本另 7 通过 | `semantic-clarification-server-tests.log` |
| Shared 全量 | 281 通过 | `semantic-clarification-shared-tests.log` |
| Web 全量 | 93 文件、493 测试通过 | `semantic-clarification-web-tests.log` |
| 全工作区类型 | 退出码 0 | `semantic-clarification-workspace-typecheck-final.log` |
| 最终 Server 构建 | 退出码 0；先于最终 HTTP | `semantic-clarification-build-final-verified.log` |
| 本地 Nest HTTP 与真实服务重启 | SC01–SC08 全通过 | `semantic-clarification-final-http-results.json`、`semantic-clarification-http-final.log` |
| Harness / diff | 见 manifest 中退出码及日志 | `semantic-clarification-harness.log`、`semantic-clarification-diff-check.log` |

相关服务测试与全量测试有重叠，不应相加成独立样本。26 个跳过为 21 个 PostgreSQL 和 5 个可选 Docker 测试。本轮没有真实 PostgreSQL、真实客户端点击或真实模型准确率结果。全量测试启动后仅为两个测试 fixture 增补了 TypeScript 非空断言；最终类型检查和构建覆盖该改动。

HTTP 使用真实 Nest 服务和 File 持久化，模型输出来自本地确定性 OpenAI-compatible fixture：

| 场景 | 断言 |
| --- | --- |
| SC01 | 首轮不创建虚假 WorkItem，展示唯一可用关系选项 |
| SC02 | 错误确认 ID 返回 409，模型调用数不增加 |
| SC03 | 选择后 HTTP 200，版本 1/2 历史和唯一收据保存 |
| SC04 | 相同选择重放不分类、不重复任务 |
| SC05 | 相关任务不隐式继承；反向选择 409 |
| SC06 | 模型增加执行效果被拒绝，无执行操作和解决收据 |
| SC07 | 模型连接 401 只调用一次，保留 blocked，无成功收据 |
| SC08 | 真实服务停止后重启，成功重放及失败重放都不再分类、不重复任务 |

服务级测试另覆盖选中约束的实际继承、并发同/反选择、外部 actor、陈旧/过期卡片、修复/瞬态预算、原子写失败、ready 恢复、预算耗尽恢复及迟到结果拒绝。恢复测试中的 pending/ready 状态为显式 fixture；SC08 是真实服务重启，但不是运行中进程崩溃矩阵。

## 保留的失败证据

`semantic-clarification-http*.log` 及对应早期 JSON 保留。最初测试模型服务把 GET 健康探测当作 JSON POST 解析，返回 500，导致运行时不可用、零分类请求。修正 fixture 对非模型路径返回 404 后，7 项验证通过；增加真实重启后最终 8 项通过。没有放宽断言或修改真实模型连接。

早期类型检查暴露 bootstrap 参数和测试 fixture 的可选 generation 类型问题，均已修复。早期服务测试因 fixture 缺新合同标记失败并等待，已补标记和有上限的等待；这些日志不计为通过。

## 尚未完成

本增量只覆盖单段消息的任务关系选择。纠错目标选择器、多段消息逐段澄清、更广泛的缺字段问答尚未完成；不能据此声称所有歧义均可解决。源码/产物/外部效果执行与补偿、ordered_plan、完整任务/Brief 派发、PostgreSQL/CLI/双端/多进程矩阵、独立人工双标数据与发布门槛仍待完成。保持 IR02–IR13 未完成整组的原状态，不把这些测试当作意图准确率。
