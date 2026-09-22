# 工作流缺少 Agent 时的证据化邀请与拒绝引导 - Plan v1

> 状态：核心设计已实施，Web/桌面生产 renderer 双客户端验收通过；原生 Electron 进程验收受环境阻塞。依据：[Spec](../product/workflow-agent-invitation-spec-v1.md) | [Tasks](../implementation/workflow-agent-invitation-tasks-v1.md) | [Checklist](../quality/workflow-agent-invitation-checklist-v1.md)

## 1. 决策与边界

选择在现有 `selectWorkflow` 与 `resolveWorkflowMemberMapping` 路径上增量闭环，不另建流程启动状态机。成员缺口是发布图 `involvedAgentIds` 与会话 `participatingAgentIds` 的差集；节点说明和审核标准只能取自对应发布快照，不让模型凭空证明需求适配性。批准仍写入现有会话成员集合，运行依旧按锁定图节点指派；拒绝只影响本次选择。

本设计不改变群聊参与者的判定：现有讨论从会话成员读取可用 Agent，因此工作流批准的成员以后可能被讨论路径使用。此前讨论的运行级生命周期方案明确延期，不在此专项中以 UI 文案暗示已经实现。

## 2. 状态与接口

| 阶段 | 权威状态 | 行为 |
| --- | --- | --- |
| 初次选择 | `select_workflow` 确认 + 已发布版本 | `POST /sessions/:id/workflow/select` 校验需求、流程和成员 |
| 缺口待决定 | 服务端 `confirm_workflow_member_mapping` 事件 | 唯一有效卡片锁定原 selection confirmation、workflowId/version/hash、需求/文档绑定和会话 generation；选择框不抢焦点 |
| 批准 | `POST /sessions/:id/workflow/member-mapping` | 服务端检查卡片仍有效、所有缺口均可邀请、Agent 仍活跃；加入成员并记录决定；同一原选择再次经过现有 `selectWorkflow` 校验后启动 |
| 拒绝 | 同一接口 `decline` | 只解决映射卡，保持 `WAIT_WORKFLOW_SELECT`；原选择不启动，显示改选/到 Web 新建流程入口 |
| 新流程 | Web 端现有流程编辑/发布接口 | 发布后刷新目录，由用户重新选择；桌面只读 |

批准与原流程选择应按一个业务操作串联：后端持久记录原选择绑定以便刷新后继续，前端不可只凭自身缓存恢复。加入成员和创建运行若跨请求，必须能在断线重试时继续原选择、拒绝不同载荷重放，且不重复创建 run。若无法实现原子组合，应明确呈现“已加入，待继续启动”，不得把邀请成功说成启动成功。

继续使用现有 file/PostgreSQL 持久化投影和事件 outbox；如需新增持久字段，迁移与重建读写必须同时覆盖，不能仅保存在内存。`definitionHash` 与文档确认范围均由后端读取并校验，客户端送回的值不能单独作为授权证据。

## 3. 映射与证据模型

从发布版本节点列表按 Agent ID 聚合：

- `agent` 节点提供 nodeId/name、stageDescription、inputContract、outputContract。
- `robot_approval` 节点提供 nodeId/name、reviewPrompt、criteria；这是质量审核节点，不得因拒绝而自动省略。
- 对同一 Agent 保留所有关联节点；依据 Agent 目录显示名称和 active/disabled/unknown，区分“尚未加入会话”和“当前不可用”。
- 影响说明使用确定性陈述，例如“未加入则所选流程的前端开发节点无法按发布图执行”；无配置字段标未知，不把节点存在推断为需求一定需要它。

建议扩展共享的确认事件/投影字段（具体字段名由实现时合同测试冻结）：`selectionConfirmationId`、`workflowId`、`workflowVersion`、`definitionHash`、`memberGaps[]`；每项包含 `agentId`、`agentName`、`reason`、`nodes[]` 与可邀请标记。Web `ConfirmationRequestedPayload`、`ConfirmationCardState` 和事件 store 必须保留这些字段；桌面复用数据类型，但各自渲染。

## 4. 交互设计

1. 选择流程后，出现成员缺口时只展示邀请卡；保留原流程名称、版本及返回目录按钮，不再自动重开选择弹窗。
2. 卡片先列成员和节点依据，再给出批准或拒绝动作；混合 disabled/unknown 时只允许返回或解决配置，不允许“邀请部分成员并启动”。
3. 拒绝的服务端回执到达后弹出结果对话框，列明被拒 Agent 和原流程不能运行的节点，提供“选择其他已发布流程”和“在 Web 创建新流程”。Web 跳转现有管理页面；桌面使用可访问的 Web 地址或外部浏览器入口，绝不嵌入写入型编辑器。离开/返回不清空已确认需求；关闭对话框也不自动重开选择框。
4. 批准后先显示真实后端回执，随后继续原选择或展示明确的“继续启动”状态；两端等待服务端事件收敛，不用本地伪造 resolved 事件作为权威结果。
5. 质量节点移除是新流程的显式设计变更，界面提示审核覆盖将改变；服务端仍按新发布图及现有发布门禁验证，不在本专项定义自动放宽的质量策略。

## 5. 竞争、失败与恢复

- 对同一 session/selection/发布版本的重复提交只保留一张有效映射卡。Web/桌面竞争批准/拒绝时，首个服务端已提交决定为准，另一端获得幂等结果或明确冲突。
- 决定前或启动前复核 workflow version/hash、当前需求/文档确认、Agent 可用性、会话 generation 和停止屏障；改变时提示重新选择，不自动替换图。
- 复核全部缺口，不允许部分邀请后称为可启动；此前已加入的 Agent 可保留现有成员语义，但未完成启动必须明确显示。
- 卡片、选择及决定经服务端事件恢复；断线/刷新不重放模型，也不因本地 optimistic 事件吞掉待决卡。

## 6. 变更落点与验证

允许修改：`apps/server/src/modules/sessions/`、`apps/server/src/modules/workflows/` 中的映射/确认、`packages/shared/src/` 合同、`apps/web/src/types/contracts.ts` 与 Store/确认卡、`apps/desktop/renderer/components/` 的展示与处理，以及对应 API/event/UI 合同和测试。Web/桌面布局保持独立。

禁止修改：Agent 全局定义、流程运行图的执行/返工语义、会话结束自动移除机制、生产凭据及用户源码。先以合同/失败用例锁定状态转移，再做后端幂等与双端接线；验证入口见 [Checklist](../quality/workflow-agent-invitation-checklist-v1.md)。

回退时可关闭新的邀请解释/继续操作入口，但不得跳过原有成员准入或删除持久化决定；对未知状态保持 WAIT_WORKFLOW_SELECT 且不启动。

## 7. 实施与验证注记

实现沿用本设计的增量路径，没有引入运行级临时成员或新的工作流状态机。批准时额外绑定 Brief 版本与 Session generation，并在重复决定时恢复已记录的运行。file、隔离 PostgreSQL、Web/桌面组件和客户端分离用例均已验证；专项双客户端 E2E 还覆盖了跨端竞争决定、冲突端权威状态同步、SSE 重连补偿、刷新恢复、明确重选和唯一启动。该 E2E 使用真实后端 HTTP/SSE 与两套生产 bundle，只替换 Runtime，不调用真实模型。

原生 Electron renderer 仍在本机 Chromium/GPU 进程初始化阶段崩溃，发生在页面代码加载前；沙箱外复验因审批服务模型配置 `404` 未被执行。因此不能用生产 renderer 的 Chromium 结果替代 Electron 进程验收，T5/T6 的该质量门保持未完成。
