# 首轮自动 Brief 草稿开发记录

Run ID：`SDD-2026-10-20-brief-executor`。IR06/IR09 从存储基础推进到真实首轮自动草稿；确认后的完整业务链仍未完成。

## 已接通行为

真实 PlanCommit 对新合同的单段 create_initial_work_item，在无请求执行效果、无指定 Agent、输入/讨论状态且没有当前 Brief 时派生 prepare_brief。创建 WorkItem、父/子步骤、不可变版本与事件同事务保存，父创建步骤 completed、派生步骤 queued；提交成功后才调度。问答与现有隔离测试路径不派生该步骤，多段继续澄清。

新 `IntentBriefExecutorService` 使用独立 operation、持久化租约、最多两次调用与最多 120 秒绝对时限；更短的 phase 配置仍生效。格式错误一次修复、瞬时错误受剩余次数/时限及 Retry-After 限制，401/403 单次失败。Generic LLM 内层修复关闭，反馈带原文来源，避免一次平台调用藏多次修复。停止未知不发起新调用，进入 reconciliation_required。

Runtime 只接当前计划绑定的无工具草稿阶段，当前有效 Decision 与原请求进入上下文，不扫描工作区，不委派任务。保存候选后发布失败保留结果；恢复领取新的 owner 后仅补发，不重复模型调用。纠错 hold 或版本变化拒绝迟到结果，失败不能覆盖已被纠正/冻结路由的新状态。超时返回预算耗尽，不错误标成语义误识别。

发布同时将 Session 设置为 WAIT_USER_CONFIRM、WorkItem 设置为 WAITING_USER。API 从持久化读取新 Brief；旧 Orchestrator 的 Map 写入改为事务保护新合同会话的 Brief/建议任务，其他旧会话的保存不能抹掉新结果。Session 缓存取得新草稿时，不覆盖正在提交的暂停/取消/中断/完成状态。

旧 Brief 生成、确认及修订入口拒绝新合同旁路。新草稿仍待确认，旧确认 API 返回 409 且不启动建议任务；该拒绝是确认后新业务链尚未接通时的明确状态，不是完整确认功能。下一步需实现版本化确认、修订与独立执行授权，不能删除守卫后回接旧流程。

## 验证结果

| 范围 | 结果 |
| --- | --- |
| Brief/Orchestrator/Sessions 相关回归 | 265 通过 |
| Server 全量 | 2183 + 7 通过，0 失败，41 条件跳过 |
| 最终 Brief/缓存/截止时间专项 | 22 通过，0 失败 |
| PostgreSQL 存储及既有意图事务 | 36 通过，0 失败，0 跳过，容器已清理 |
| 实际 Sessions HTTP | BE01–BE06 共 6 项通过 |
| 全仓类型检查、最终 Server 构建 | 通过 |

Server 全量之后补充了截止时间错误分类、WorkItem 待确认状态及本地暂停缓存保护，最终 22 项覆盖这些增量，最终 Server 构建覆盖全部源码。最后 HTTP 覆盖 WorkItem 状态改动；最后一个缓存暂停守卫随后由专项测试覆盖。全仓类型检查早于这几个后端增量，最终 Server 构建对后端重新编译。没有把较早全量或 HTTP 冒充最后源码的全部检查。

41 条件跳过包含 36 PostgreSQL 和 5 可选 Docker 执行器测试；本轮独立 PostgreSQL 36 项通过，5 个可选 Docker 执行器测试未重跑。数据库运行只覆盖事务层，不声称 PostgreSQL 自动 Brief HTTP/执行器跨进程矩阵通过。计数互有重叠，不合计成独立场景数。

HTTP 使用实际 Nest/Runtime/Generic LLM/File 和确定性 localhost provider：

- BE01：识别一次、Brief 一次，工具为空，计划中的派生步骤完成后只有一个草稿。
- BE02：Session/Brief API 读取同一持久化草稿，Session/WorkItem 同时待确认，零 AgentTask。
- BE03：旧确认返回 409，不能将草稿当业务执行授权。
- BE04：首次格式错误，第二次带反馈修复；两次草稿调用共享持久化计数。
- BE05：401 只调用一次，保留失败步骤，不生成草稿或确认卡。
- BE06：实际停止并重启服务，已完成草稿可读且不重复模型调用。

单元/服务验证另覆盖并发实例、保存后发布失败/重载、暂停/过期/未知停止、运行中纠错、旧 Map 污染拒绝、旧入口拒绝和迟到预算失败。测试夹具调用真实 PlanCommit 派生步骤，不再手工将 prepare_brief 插入生产事务。

## 失败和修正

首次缓存验证错误地把 Persistence 传给 Orchestrator 夹具的 fileRevisions 参数；修正为真实 options.persistence 后通过。改为异步事务后，一个旧测试的 persistBriefs stub 仍返回 undefined，已更新为 async。初始类型检查发现 Orchestrator 没有 logger 字段，使用现有框架 Logger 记录失败，不输出存储内容。失败日志与最终日志分开留存。

## 尚未验收

仅首轮、无外部效果的创建任务自动生成草稿；相关/独立新任务、复杂 Brief 修订、确认后专业执行、源码和外部效果仍待实施。旧确认/修订目前明确拒绝，不能宣称可完整执行任务。真实双端/Electron/SSE、全部 CLI/数据库 HTTP/崩溃矩阵、58 场景与独立 500+ 双人标注三轮模型评测、发布授权及观察门仍未通过。

固定 provider 仅验证工程行为，不代表语义准确率；本轮没有整个工作区测试或完整前端构建。Plan、Task、Checklist 和合同已同步，Spec 目标不缩减，整体目标保持进行中。没有提交、部署、生产数据库或个人模型配置变更。
