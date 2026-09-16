# 执行停止状态一致性与通知 Plan v1

状态：2026-09-15 已按本设计完成实现，并通过独立 PostgreSQL 故障矩阵和完整验收。

依据：[Spec](../product/runtime-stop-consistency-spec-v1.md) | [Tasks](../implementation/runtime-stop-consistency-tasks-v1.md) | [Checklist](../quality/runtime-stop-consistency-checklist-v1.md)。

## 1. 现状与选型

- `RuntimeService.start` 的 finally 先 await `operations.settle` 后删除 `supervised`，保存异常会留下已结束句柄。
- `hasUnconfirmedStops` 将监督活跃数、逻辑操作未知停止、连接层等待状态做 OR；它不说明阻塞对象或原因。
- `LocalRuntimeConnectionService.confirmStopReceipt` 已有事务匹配与重复通知保护，但更新停止事实和 Session 创建事件仍分离。
- `SessionsService` 收到通知即 `events.create`；会话摘要直接使用最后事件。Web 按事件 ID 去重，无法合并后端生成的不同事件 ID。
- 已存在 `mutateCollections`、集合锁、事件 outbox 和 Local Runtime 持久化回执；优先扩展这些设施。

选择“修复监督清理 + 会话停止聚合 + 事务事件”。仅 UI 折叠无法恢复阻塞会话；仅把 delete 放 finally 可能错误释放未知进程屏障；本专项不采用重写整个运行时的方案。

## 2. 架构边界

允许变更：server 的 runtimes、local-runtime、sessions、events、persistence、必要 recovery 调用点；shared 合同；local-runtime-cli 回执兼容；Web 共享 store/API 与双端停止状态组件；定向测试和合同文档。

禁止顺带改动：编排业务阶段、模型选择、Provider 策略、目录授权、工作区写回规则、无关页面样式和 Harness 产品化。新增停止聚合归 Runtime/Session 现有职责，不新增通用工作流引擎。

保持 `LogicalOperation.stopState` 为调用级事实。停止聚合是 Session 级固定目标集合，不能成为与调用事实相互独立更新的第二套真相。

## 3. 调用结束与保存失败

监督退出使用嵌套 try/catch/finally。最终 finally 无条件清理监督句柄、定时器和事件资源；按同一 handle 身份删除，避免误删替代条目。

进入保存步骤前捕获结束证据及原始结果。纯取消请求、超时合成结果和断线拒绝属于结束未知；真实 adapter 进程关闭/result 协议或经绑定验证的 stopped 才能作为可信证据。不得把任意 Promise settled 当作真实退出。

保存失败时：

1. 创建以 invocationId 为键的进程内待同步记录，先登记阻塞，再清理句柄，避免 admission 短暂放行。
2. 返回现有失败结果结构内的明确错误（拟定 details.reason 为 `STOP_STATE_PERSISTENCE_FAILED`），保留终止原因、原结果摘要和诊断引用；未提交的成功结果不得向编排器交付为成功或触发写回。
3. 同一后台恢复通道有限重试结束事实写入；不能为重试启动模型或应用业务输出。
4. 成功提交后清除匹配的内存待同步项，并更新停止摘要；保存长期失败进入“需要处理”状态。

即使原结果的业务记录保存失败，停止事实也应允许单独提交；任务失败与进程停止分别表达。

进程内记录不是跨崩溃保障。现有调用预留必须先持久化再启动进程；重启发现遗留 running/activeInvocationId 且无可信证据，恢复为未知停止并阻止继续。Local Runtime 持久化回执可重传；server_local 丢失结束证据时不得仅凭 PID 不存在推断安全结束。

## 4. 停止请求与状态聚合

拟增加 SessionStopRequest 记录：`id`、`sessionId`、`reason`、`targetInvocationIds`、`version`、`status`、`createdAt`、`updatedAt`。每个目标关联 operationId 和既有 transport 绑定，保存已提交的结束证据引用。

聚合状态为 `requested`、`waiting`、`confirmed`；待持久化失败属于查询返回的阻塞原因，不伪造已持久化的新版本。每次有效目标状态变化增加 version；重复回执不增加。计数从目标状态派生，不独立维护可漂移计数器。

停止请求创建与 invocation reserve 使用同一集合锁/事务约束：原子冻结当前已预留且未确认结束的调用集合，建立新启动屏障，再发送取消。重复停止请求返回现有非终态 stopRequestId；确认后新一轮请求使用新 ID。零目标直接 confirmed。

数据库不可用导致无法创建停止记录时，仍尽力取消已知本地句柄，并立即设置进程内 admission 屏障；不得谎称请求已持久化。恢复时从既有持久化预留及可信回执建立/核对记录；无法恢复数据库时所有需预留的新执行本就不得启动。

Runtime 层提供统一查询 `getStopSummary(sessionId)`，返回停止 ID/版本、目标和确认数、阻塞列表及 `canResume`。内部不再用裸 active count 推断停止进度。`canResume` 只表示停止屏障已解除，Session 恢复入口还必须检查失败检查点、用户决策、权限与预算。

暂停、取消、超时、断线采用相同调用结束核对机制，但保持各自业务终止原因；自动确认停止不等于自动恢复。

## 5. 回执、事务事件与 ACK

统一 result/stopped 的结束证据入口，校验 invocation/device/workspace/runtime；旧调用的迟到结果丢弃业务输出。stopped 先于 result 到达时不能直接因 activeInvocations 存在而忽略：在验证协议和真实退出保证后，驱动对应执行等待句柄结束，再提交结束事实；缺少业务结果的非取消调用按既有错误结果结束，不伪造成功。

在一个 `mutateCollections` 事务内：读取最新调用及停止目标，应用单调确认变化，更新聚合版本，并写入事件与 outbox。显式声明 logicalOperations、停止记录、events/outbox 所需集合；遵守既有排序锁，不在锁内调用网络、模型或 EventsService 的带副作用发布方法。

状态事件拟用 `RUNTIME_STOP_STATE_CHANGED`，payload 包含 stopRequestId/version/目标计数及阻塞原因。幂等键 `runtime-stop:<stopRequestId>:<version>` 在持久化事务内判重；内存 `createOnce` 不能作为跨进程保证。outbox 允许重复投递，客户端按事件 ID 和状态版本处理。

处理结果区分 `applied`、`already_confirmed`、`rejected`。前两者仅在持久化结束事实或匹配的已确认记录存在时返回 stop_ack；绑定错误返回协议错误，不确认目标。无匹配历史记录不得发成功停止通知，也不能静默删除客户端唯一证据，应报告不可关联并保留诊断/待处理回执。

提交后进程崩溃但 ACK 未发：客户端重传，后端识别 already_confirmed 后 ACK，不发新事件。提交后发布前崩溃：outbox 补发。不得从普通回执自动重建历史业务执行。

未显式指定延迟的 outbox 使用 PostgreSQL 事务时钟设置 `available_at`，避免应用与数据库时钟偏差使已提交事件短暂不可领取；只有明确提供 `availableAt` 的延迟投递记录使用调用方时间。

## 6. 有限恢复与诊断

复用现有事务瞬时错误策略：SQL `40001/40P01` 最多三次，业务错误不自动重试。不要把旧全局 CAS 冲突改成无条件循环；在线停止事务使用最新值和集合锁。

事务尝试耗尽后的待同步队列按 invocationId 合并，单项建议采用 1/2/5/10/30 秒延迟、最多五轮；每轮仅幂等保存结束事实。耗尽后标记需要处理，不在每次 UI 轮询时重置预算。依赖恢复、可信回执重传或显式核对可触发新的受限恢复批次，不重放模型调用。服务器关闭时不为冲刷队列无限等待。

记录 sessionId、stopRequestId、operationId、invocationId、deviceId、connectionId、旧/新状态及版本、失败类型、重试批次/次数；区分 receipt_received、duplicate、commit_failed、ack_sent、reconciled。避免记录凭据、提示全文和产物正文。补充待同步数量、最长等待时间、重复回执计数及通知幂等冲突指标。

## 7. 数据合同、接口与双端

拟新增只读 `GET /api/sessions/:id/stop-state`，复用现有 Session 可访问性校验，返回统一摘要。明确未知/查询失败，不能默认 canResume=true。SSE 增加上述状态事件；读取快照后仅接受同轮更高版本，新轮按服务端顺序取代旧轮，避免请求与 SSE 竞态回退状态。

存储拟新增 `sessionStopRequestsBySession` 集合及对应 relational 映射/迁移，记录固定目标和聚合版本；事务与停止预留读取该集合。实施时检查当前最新 migration 编号，不在文档中预占版本号。file 模式有等效默认与持久化。历史会话不批量推断 stopRequest，缺少聚合记录时从调用事实返回 legacy 摘要，禁止根据聊天文案推断确认状态。

更新 shared 类型以及 API、runtime、event、data、relational、UI-state 合同。旧客户端未知事件应安全忽略；如需保留旧 `RUNTIME_STOP_CONFIRMED` 通知，仅在最终确认时兼容投影一次，新客户端不重复渲染兼容事件。Local Runtime `stopReceiptProtocol: 1` 的可信结束保证不降低，继续兼容旧 result 路径。

共享 stop-state store 供 Web 与桌面使用，各自渲染一个稳定状态区域。中间进度更新该区域，不逐条追加聊天消息；终态/异常可保留一次系统事件。完成提示为“执行已停止”，是否能继续依据 Session 状态再展示。

历史重复通知按 sessionId + runtimeInvocationId + code + stopState，在连续同类通知区间折叠；新事件使用 stopRequestId。缺少身份字段不按文案全局合并；中间业务消息/新轮次截断分组。保留展开、次数、原始时间和完整事件访问。会话摘要优先业务失败/用户决策，其次有意义的业务进度，排除纯回执。

## 8. 分批交付、验证与运行恢复

第一批：固化故障复现，完成无条件句柄清理、待同步屏障及统一停止查询/目标聚合，验证数据库失败不放行、恢复不残留。第二批：原子事件/outbox、ACK 故障矩阵、共享状态展示及历史折叠；两批均是最终验收的必选项。

验证先使用 mock/内存，再使用独立 PostgreSQL 和隔离 HTTP/WebSocket/CLI 进程；覆盖乱序、重复、保存异常、并发 reserve/stop、提交后崩溃和双端刷新。具体命令与证据在 Checklist，不用真实模型调用证明幂等。

上线前检查活动任务，按运维流程安排服务更新。迁移先于依赖新记录的代码启用；旧构建不认识停止集合时不得直接回退并继续接收新执行。回退先暂停准入、核对未确认调用，保留新增数据和屏障，再退到经过兼容验证的构建；禁止以删记录消除阻塞。

历史会话恢复为单独步骤：只读核对调用、设备和结束证据；可信证据经同一入口确认；证据缺失保留未知并给出诊断。不自动恢复模型任务、不删除原始事件、不更改权限。用户显式继续仍走原有恢复入口。
