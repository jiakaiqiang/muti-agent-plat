# Session Runtime 动态切换 Spec v1

状态：2026-09-26 已完成 SDD 需求定义，代码待实施、验收待执行。

关联：[Plan](../design/session-runtime-switch-plan-v1.md) | [Tasks](../implementation/session-runtime-switch-tasks-v1.md) | [Checklist](../quality/session-runtime-switch-checklist-v1.md)。

## 1. 背景

当前 Session 只在创建时接收 `runtimePreference`。用户在群聊中输入“使用 Claude Code 继续”时，消息会经过普通意图识别；如果 Session 已经是 `PAUSED`，消息被保存为 queued，但暂停状态又禁止消费队列。该消息既不会恢复 Session，也不会修改首选 Runtime。

现有编排已经支持可重试 Provider 故障的有限处理：首选 Runtime 首次调用失败后，在操作预算内对同一 Runtime 重试一次；仍失败时，才可以在 Session `allowedRuntimeTypes` 内选择备用 Runtime。用户暂停或取消属于显式控制，不触发自动 fallback。

本需求增加用户主动 Runtime 切换。主动切换与自动 fallback 共用 Runtime 资格校验、上下文组装、停止屏障和审计设施，但必须保持两种语义独立。

## 2. 术语

- 首选 Runtime：Session 后续新 Invocation 默认优先选择的 Runtime。
- 活动 Runtime：当前正在执行某个 Invocation 的实际 Runtime，可能因 fallback 与首选 Runtime 不同。
- 主动切换：用户通过聊天、界面或插件明确要求改变首选 Runtime，并可选择立即接管当前工作。
- 自动 fallback：可重试 Provider 故障经过同 Runtime 有限重试后，系统在授权候选中自动选择备用 Runtime。
- 当前切换阶段：从切换请求被接受，到目标 Runtime 接管的逻辑操作终止或完成。
- 可信停止：所有被替代 Invocation 均已有可验证、已提交的停止事实；仅发送取消信号不等于可信停止。

## 3. 目标

1. 用户可在群聊执行过程中把当前 Session 从 Codex、Claude Code 等 Runtime 切换到另一个已授权 Runtime。
2. “切换到 Claude Code 继续”同时表达切换和恢复，不需要先单独点击继续。
3. 切换过程中不允许旧、新 Runtime 并行拥有同一任务的执行权。
4. Agent 身份、Skill、Tool 权限、WorkItem、确认决策、附件和 Workspace 上下文在切换后保持一致。
5. 保留现有自动 fallback，并允许用户选择保留兜底、当前阶段排除旧 Runtime 或仅使用目标 Runtime。
6. 切换状态、实际 Runtime、首选 Runtime和备用 Runtime 对用户可见，服务重启后可以恢复解释。

## 4. 范围

包含：

- Session Runtime 策略合同和持久化投影。
- 主动切换请求、状态机、幂等和恢复。
- Runtime 可用性、能力、Workspace、权限和模型配置预检。
- Session 生命周期停止屏障、generation 隔离和恢复。
- 群聊自然语言、显式 UI 控件和 `/runtime` 插件的统一服务端入口。
- 跨 Runtime 的标准上下文重建和可信执行候选复用。
- 自动 retry/fallback 与主动切换的协调。
- Web 群聊的 Runtime 状态展示和切换反馈。
- API、Data、Event、Runtime、UI-State 合同与测试。

## 5. 非目标

- 不允许把 Codex CLI session ID 交给 Claude Code，或反向跨 Runtime 原生 resume。
- 不改变 Agent 身份、职责、Profile、Skill 或 Tool Authority。
- 不绕过管理员 Runtime 允许范围、Workspace 能力或危险操作审批。
- 不把不可重试的认证、合同、权限或能力错误静默降级为 fallback。
- 不通过关闭停止屏障、延长超时、隐藏错误消息或并行启动替代 Runtime 实现“快速切换”。
- 不自动重放缺少可信检查点的历史写操作。
- 本 SDD 不负责新增 Runtime Adapter 或供应商账号配置。

## 6. 策略规则

RuntimePreference 必须区分选择、授权和顺序：

```ts
type RuntimePreference = {
  preferredRuntimeType?: RuntimeType;
  preferredModelId?: string;
  allowedRuntimeTypes?: RuntimeType[];
  fallbackRuntimeTypes?: RuntimeType[];
  revision?: number;
};
```

- `allowedRuntimeTypes` 是无序授权集合。
- `fallbackRuntimeTypes` 是有序降级链，必须是允许集合的子集，且不得重复首选 Runtime。
- 旧 Session 缺少 `fallbackRuntimeTypes` 时，按现有 `allowedRuntimeTypes` 顺序排除首选 Runtime 后派生。
- 最终候选集合为：管理员允许范围、Session 允许范围、Workspace 能力、任务 Tool/Capability 要求和当前可用 Runtime 的交集。
- 管理员策略定义权限上限和默认值；用户在 Session 中的合法显式选择优先于管理员默认值。

主动切换提供三种 fallbackMode：

| 模式 | 行为 |
| --- | --- |
| `keep` | 目标 Runtime 失败后可立即按既有 fallback 顺序选择旧 Runtime |
| `exclude_previous_once` | 当前切换阶段排除旧 Runtime；阶段结束后恢复正常 fallback，作为默认模式 |
| `target_only` | 将当前 Session 的允许范围收紧为目标 Runtime，直到用户再次修改 |

## 7. 行为要求

### 7.1 入口与识别

- UI Runtime 选择器、聊天文本和 `/runtime` 插件必须调用同一个服务端切换命令。
- 确定性解析支持“切换到/改用/使用 + Runtime 名称”及可选“继续/恢复”。
- “为什么使用 Claude Code”“比较 Codex 和 Claude Code”等问句不得触发切换。
- Runtime 别名来自统一注册表，不在多个端分别维护字符串列表。
- 切换命令必须先于普通消息 deferred/queued 判断处理；不得先入 FollowUp 队列再尝试恢复。

### 7.2 预检与停止

- 停止旧 Runtime 前必须预检目标 Runtime 的注册、在线、Workspace、Capability、Tool、模型和权限条件。
- 预检失败时保持当前执行不变，并返回可操作错误。
- 存在活动调用时，切换先关闭 Session 新执行准入，再停止 Intent、Brief、Execution 和 Runtime Invocation。
- 未取得可信停止证据时，目标 Runtime 不得启动；切换保持 `stopping` 并允许幂等重试停止。
- 没有活动调用时可直接应用策略；PAUSED Session 在 `resumeAfterSwitch=true` 时完成策略更新后恢复。

### 7.3 上下文接管

- 目标 Runtime 使用新的 invocationId、attemptGroupId 和 CLI session。
- 平台从 WorkItem、任务契约、决策账本、消息、附件、讨论文档、Agent 身份、Skill/Tool 权限、Workspace 快照和上游产物重建 ContextEnvelope。
- 讨论/只读阶段从当前平台检查点重建当前阶段。
- 写任务只允许复用已捕获且仍通过基线、版本、权限和输出合同校验的 executionCandidate；否则从最后可信任务检查点重新执行当前阶段。
- 切换不得把旧 Runtime 的迟到业务结果、文件写回或终态应用到新 generation。

### 7.4 自动 fallback

- 自动 fallback 只处理 `retryable=true` 且 `providerFailure=true` 的失败。
- 同一 Runtime 最多自动重试一次；长操作默认平台调用总上限仍为 3，除非权威 Runtime 合同另行变更。
- 每次物理调用使用新的 invocationId，审计保留 attemptGroupId、retryOfInvocationId、fallback 来源和原因。
- 主动切换建立新的 attemptGroupId；不占用旧失败调用的自动重试额度，但继续受 WorkItem Token 预算约束。
- `exclude_previous_once` 只影响当前切换阶段，不永久删除旧 Runtime 的授权。

### 7.5 持久化、恢复和幂等

- RuntimeSwitchRequest 必须持久化，不得只存在于内存 Promise 或前端状态。
- 请求使用 Idempotency-Key；相同键返回同一请求和状态，不重复停止或启动 Runtime。
- 请求带 expectedSessionRevision；并发或过期切换返回 409，不采用最后写入者静默覆盖。
- 服务重启后：`stopping` 重新核对停止状态；`stop_confirmed/applying` 可幂等继续；写能力的 `resuming` 没有可信候选时等待用户，不自动重放。
- 切换应用必须原子更新 Session RuntimePreference、Session revision、生命周期 generation、切换状态和 outbox 事件。

### 7.6 展示

- UI 分别展示首选 Runtime、当前活动 Runtime、备用 Runtime 和切换状态。
- 至少展示：正在预检、正在停止旧 Runtime、等待停止确认、正在启动目标 Runtime、切换完成、切换失败。
- 切换中禁用重复切换，但保留停止和查看详情能力。
- 前端以服务端快照和 SSE 版本为准，不因旧事件把完成状态回退为处理中。

## 8. 不变量

- I1：旧 Runtime 未可信停止时，新 Runtime 不得取得执行所有权。
- I2：切换 Runtime 不改变 Agent 身份、任务目标、Skill、Tool 权限或知识绑定。
- I3：跨 Runtime 不复用 CLI session，只复用平台可信上下文和候选产物。
- I4：用户主动切换、Provider retry、自动 fallback 和用户暂停具有不同的审计原因。
- I5：授权集合和 fallback 顺序分离；顺序变化不能扩大权限。
- I6：迟到结果不能跨生命周期 generation 写回。
- I7：目标 Runtime 预检失败不能先停止仍健康的当前 Runtime。
- I8：服务重启不自动重放未确认副作用。

## 9. 验收标准

| 编号 | 可验证要求 |
| --- | --- |
| SRS-AC1 | 活动 Codex 会话收到“切换到 Claude Code 继续”后，停止 Codex、更新首选 Runtime，并由 Claude Code 接管同一 WorkItem |
| SRS-AC2 | PAUSED Session 的复合切换命令不进入永久 queued 状态，完成切换后恢复并处理既有等待消息 |
| SRS-AC3 | 目标 Runtime 预检失败时不停止当前调用、不修改首选 Runtime，并返回结构化错误 |
| SRS-AC4 | 停止未确认时不启动目标 Runtime；重试停止幂等，迟到旧结果不写回 |
| SRS-AC5 | 跨 Runtime 保持 Agent、Skill、Tool、WorkItem、决策、附件和 Workspace 上下文，且不跨 Runtime 复用 CLI session |
| SRS-AC6 | `keep`、`exclude_previous_once`、`target_only` 三种 fallbackMode 行为符合定义，授权范围不被扩大 |
| SRS-AC7 | retryable Provider 故障保持“同 Runtime 重试一次，再按有序备用链 fallback”；不可重试错误 fail closed |
| SRS-AC8 | 重复请求、并发请求和 stale revision 不造成重复停止、重复 Invocation 或策略覆盖 |
| SRS-AC9 | 服务在 stopping、applying、resuming 各阶段重启后均恢复到可解释且安全的状态，不自动重放未确认写操作 |
| SRS-AC10 | Web 展示首选、活动、备用和切换阶段；刷新/SSE 重连后状态不倒退，窄屏无重叠 |
| SRS-AC11 | Coordinator 系统策略作为默认值和权限上限，不覆盖 Session 内合法的用户显式选择 |
| SRS-AC12 | API、Data、Event、Runtime、UI-State 合同、file/PostgreSQL 持久化、相关 E2E 和构建门禁全部通过 |

## 10. 完成标准

只有 Checklist 中 SRS-AC1 至 SRS-AC12 均有实际证据、未通过项已修复或明确阻塞，才能将本 Spec 标记为完成。创建四份 SDD 文档不表示功能已实现。
