# Workspace-Aware Agent Context v2 主链路闭环方案 v1

> 日期：2026-07-12
> 状态：本地实现与自动化验证完成；真实外部 Runtime 验收仍受独立门禁控制
> 上游目标：[`../agent-task/system-design.md`](../agent-task/system-design.md)

> **覆盖说明（2026-07-12）**：历史兼容、Agent/Runtime 合同和切换策略以 [`context-pipeline-v2-only-agent-decoupling-system-design-v1.md`](context-pipeline-v2-only-agent-decoupling-system-design-v1.md) 为准；本文继续作为 Context Envelope、Workspace Plane 和 Browser Broker 已有实现参考。

## 1. 问题

此前系统同时存在两套执行语义：

- 旧实现曾在 Session 创建时固化 Runtime/Model，并兼容 Agent Runtime override。
- 当前系统只保留 Context v2：Agent 只定义角色、Skill、Tool 和权限；每次调用按任务、阶段和 Workspace 能力解析执行目标。

Context v2、Workspace Provider、Browser Broker 和动态路由已有组件测试，但未进入 Session -> Orchestrator -> Runtime 主链路，导致任务状态高估。

## 2. 权威决策

- 所有 Session 使用动态执行目标，禁止读取 `Agent.runtimeType/modelId` 决定实际 Runtime。
- 不提供 v1 Session、固定 Runtime/Model 或 Agent override 的历史兼容执行分支。
- Runtime 无法满足任务能力时 fail closed，返回 `CAPABILITY_BLOCKED`，不静默回退。
- v2 Runtime 输入以 `ContextEnvelopeV2` 为工作区上下文权威面；旧 Snapshot/Manifest/Evidence/ProjectMap 不重复进入 Runtime payload。
- 源码分析或代码任务缺少可用 L3 Evidence 时返回 `CONTEXT_INSUFFICIENT`，经 Workspace Provider 补读后重试。
- Local Runtime 使用受认证的运行时连接完成注册、心跳、操作分发、结果回传和断线清理；服务器不再挂载浏览器 `/workspace-broker` WebSocket。

## 3. 主链路

```text
Session(v2)
  -> Context Router + legacy evidence selection
  -> build ContextEnvelopeV2 L0-L6
  -> resolve invocation execution target
  -> strip duplicated legacy workspace payload
  -> token fitting + grounded evidence gate
  -> Runtime Adapter
  -> CONTEXT_INSUFFICIENT
  -> WorkspaceProvider.readFile(requestedPaths)
  -> hydrate Session snapshot
  -> rebuild envelope and retry same task
```

## 4. Agent 解耦

- Agent Profile Compiler 是 Markdown/Skill/Tool 的统一编译入口。
- 新 Agent 不持久化 Runtime/Model。
- v2 每次调用的 `ResolvedExecutionTarget` 写入 ContextPack 和 Debug 摘要。
- 默认 Agent 中的 deprecated Runtime 字段不参与实际执行目标选择。

## 5. Workspace Plane

- `ServerLocalWorkspaceProvider` 实现 list/stat/read/search/applyChangeSet。
- `BrowserBrokerProvider` 实现相同接口，通过 WebSocket 请求浏览器执行。
- Browser 写入执行 base hash 检查；ServerLocal 继续执行敏感路径、symlink、hash 冲突和写锁校验。
- 本机目录由 Local Runtime CLI 授权并注册；CLI 断线时拒绝该 Workspace 的未完成请求，浏览器不持有目录内容。

## 6. 密钥持久化

- 新写入使用 `enc-v2` AES-256-GCM，并要求 `AGENT_CLUSTER_SECRET_KEY`。
- 缺少主密钥时拒绝持久化新的 Runtime credential。
- `enc-v1` 只保留读取兼容，后续保存时升级为 v2。

## 7. 验收定义

- v2 主链路 E2E 能完成讨论、Brief、确认、执行、Review 和 Delivery。
- v2 Runtime invocation 带 `contextEnvelopeV2` 和可审计 `resolvedExecutionTarget`。
- 无 eligible Runtime 明确阻塞。
- WebSocket Browser Broker 完成一次真实 request/result round trip。
- ServerLocal Provider 在真实临时目录完成 list/read/search。
- shared/server/web typecheck、全量测试、Harness 和 build 通过。

真实 Codex/Claude/GLM、Watchdog 20 次采样、发布和部署不由本地自动化代替，继续使用显式环境 gate。
