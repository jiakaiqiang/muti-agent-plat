# 工作流缺少 Agent 时的证据化邀请与拒绝引导 - Spec v1

> 状态：已实施核心闭环并通过 Web/桌面生产 renderer 双客户端验收；原生 Electron 进程验收受当前环境阻塞。本文档不改变阶段 4 的历史验收状态。
> 关联：[Plan](../design/workflow-agent-invitation-plan-v1.md) | [Tasks](../implementation/workflow-agent-invitation-tasks-v1.md) | [Checklist](../quality/workflow-agent-invitation-checklist-v1.md)

## 1. 目标

用户确认需求并选择一个已发布工作流后，如果该流程包含当前会话尚未参与的 Agent，主 Agent 必须说明具体是谁、位于哪个节点、该节点承担什么职责及缺失的影响，让用户决定是否邀请。用户拒绝时，不启动原流程；弹出结果对话框，明确引导改选其他已发布流程，或前往 Web 端创建、发布不包含该 Agent 的新流程，再回来重新选择。Web 与桌面呈现各自样式，使用同一业务状态。

## 2. 当前事实与问题

- [发布版本](../../apps/server/src/modules/workflows/workflows.service.ts)从 Agent 节点及机器人审核节点生成 `involvedAgentIds`；[映射器](../../apps/server/src/modules/sessions/workflow-member-mapping.ts)将该集合与会话 `participatingAgentIds` 比较，输出 `not_participating`、`disabled`、`unknown`。这是流程结构的确定性证据，不是模型判断当前需求需要某专家的证据。
- [SessionsService](../../apps/server/src/modules/sessions/sessions.service.ts)生成 `confirm_workflow_member_mapping` 事件，包含 `gaps`/`addableAgentIds`，批准接口目前只将可邀请的 Agent 加入会话，不自动启动原流程；拒绝只关闭映射卡。
- [共享 Web Store](../../apps/web/src/stores/session.ts)尚无该接口的 action；[Web](../../apps/web/src/components/SessionWorkspace.vue)和[桌面](../../apps/desktop/renderer/components/SessionWorkspace.vue)确认处理器均缺少该 reason 的分支，[事件投影](../../apps/web/src/stores/event.ts)未保留 `gaps`。当前选择卡可再次弹出，前端本地确认不能代替后端决定。

## 3. 范围与已确认约束

1. 本专项只修复工作流成员缺口的说明、确认与返回选择闭环；保留现有 `session.participatingAgentIds` 和 WorkflowRun 执行机制。
2. 不实施“工作流结束自动移除 Agent”或按运行分离群聊/执行资格。批准后 Agent 仍是会话成员，未来讨论的候选来源保持现状；本专项不得承诺“只参加本次工作流”。
3. Agent 定义和工作流节点不能由主 Agent 或桌面端改写。创建、编辑、发布新流程只在 Web 流程管理中完成；拒绝不能自动删节点或绕过机器人质量审核。
4. 已确认需求及文档版本继续有效，但选择新工作流必须重新提交选择并校验；不把拒绝变成执行授权。
5. 解释只引用发布版本、Agent 目录和当前会话成员事实。若没有当前需求与节点的可核查关联，不得写“需求必须由该 Agent 完成”或虚构可替代 Agent、成本及产物。

## 4. 用户可见流程

```text
确认需求 -> 选择已发布工作流 -> 成员差异校验
  无缺口 -> 沿用现有唯一启动路径
  有缺口 -> 关闭选择弹窗，显示带证据的邀请/阻塞卡
    可邀请且用户批准 -> 后端加入会话 -> 按原选择的版本/确认重新校验 -> 唯一启动
    用户拒绝 -> 不加入、不启动 -> 弹出拒绝结果对话框
      改选其他流程 / 前往 Web 新建并发布 -> 用户重新选择
    disabled/unknown -> 说明不可邀请 -> 改选或去 Web 修订并发布流程
```

桌面端“前往 Web”应给出可用入口及返回当前会话的方法；若无法从桌面直接打开 Web，也必须显示 Web 地址和导航指引，不能打开桌面编辑器。Web 端创建新流程后不自动选中、不自动启动。

## 5. 验收条件

- **WAI-AC1 缺口来源**：对锁定的发布版本，仅 Agent 节点与机器人审核节点所引用、但未参与会话的有效 Agent 可邀请；`disabled`/`unknown` 不能批准邀请。展示所有缺口，混合缺口不能通过只邀请一部分而启动。
- **WAI-AC2 证据**：每位缺口 Agent 展示姓名、节点名称/类型、阶段描述、已配置的输入/输出合同或审核标准、缺口原因、不能执行该节点的影响、流程名/版本。没有配置的字段标“流程未提供”，不得生成推测性需求匹配结论；相同 Agent 的多个节点均可回查。
- **WAI-AC3 批准**：点击批准必须由后端确认接口记录；加入成员后针对原流程 ID、版本、definitionHash、需求/确认范围和会话准入重新校验，再按现有启动路径至多启动一次；不得仅靠本地事件消除卡片。
- **WAI-AC4 拒绝**：点击拒绝只关闭此次映射请求；不新增成员、不创建 WorkflowRun、不更改已发布图。拒绝结果弹窗明确显示被拒 Agent、原流程无法执行的原因，提供“选择其他流程”和“前往 Web 创建新流程”，返回后必须明确重选。
- **WAI-AC5 双端与恢复**：Web/桌面展示同一缺口与决定，页面刷新、SSE 重连和重复点击不产生第二张有效邀请卡或重复启动；未处理时不得自动反复弹出工作流选择框。
- **WAI-AC6 安全与权限边界**：确认卡版本过期、流程已下架、Agent 被禁用、会话停止/删除或需求版本变化时 fail closed，重新计算后等待用户决定。桌面流程目录保持只读，拒绝不能静默替换/删减质量节点。
- **WAI-AC7 现有行为保持**：批准仍使用当前会话成员机制；无缺口路径、群聊参与规则、图内返工、已有历史运行不因本专项改变。

## 6. 非目标及遗留

- 不实现工作流 Agent 的运行级临时成员身份、结束后自动移除、讨论/执行成员隔离；这些是后续独立架构议题。
- 不增加模型推荐 Agent、自动生成流程、Agent 自动替换或授权/权限认证体系。
- 不将主 Agent 的解释作为需求适配性证明；当前可证明的是发布图对该 Agent 的结构依赖。

退出标准：WAI-AC1～AC7 全部取得实际代码与测试证据后，才可将本专项标为通过；仅生成四件套不算完成。

## 7. 实施结果（2026-09-20）

已完成：发布图证据聚合、Web/桌面确认卡、服务端批准/拒绝闭环、幂等与竞争处理、原选择唯一继续路径，以及 workflow/version/hash、需求 Brief、Agent 状态和 Session generation 的 fail-closed 复核。拒绝不会加人、改图或创建运行；批准重放返回已记录的 WorkflowRun。

已通过专项双客户端 E2E 验收：Web 与桌面生产 renderer 同时在线时展示相同缺口和节点证据；Web 拒绝与桌面批准竞争以服务端首个提交为准，失败端会重新同步权威状态；SSE 断线重连、刷新恢复、明确重选、批准唯一启动和批准重放均已覆盖，并保留待决/已解决截图。

尚待环境补验：当前 Windows 主机的原生 Electron 渲染冒烟。Electron renderer 在 Chromium/GPU 进程初始化阶段崩溃，页面代码尚未加载；沙箱外复验又被审批服务的模型配置 `404` 阻止，未实际执行。正式桌面构建、桌面组件测试及同一生产 renderer 的 Chromium 验收已通过，但这些证据不替代原生 Electron 进程验收。
