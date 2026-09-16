# 主 Agent 协作阶段 0：现状、差距与迁移基线 v1

> 日期：2026-09-16
> 范围：当前工作树的只读盘点、共享合同实现和隔离单元测试；不是已部署版本承诺。

[阶段 0 四件套](../product/main-agent-collaboration-phase-0-spec-v1.md) | [冻结合同](../contracts/main-agent-collaboration-contract-v1.md) | [验证结果](../quality/main-agent-collaboration-phase-0-checklist-v1.md)

## 1. 现状与目标差异

| 能力 | 当前入口/事实 | 后续差距与负责阶段 |
| --- | --- | --- |
| 受保护主 Agent | AgentCatalog/SystemAgentRegistry 解析 coordinator；AgentDefinition 不持有 Runtime/Model | 继续复用角色，正式用户沟通/文档发布统一入口在阶段 3/4 |
| 意图分流 | MessageIngress 原子记录消息与 @；精确命令、SemanticIntentRouter、RouteApplication 已拆分 | 扩展 bounded 近期对话/历史候选与 replyTo，阶段 2A |
| 需求事实 | WorkItem、DecisionRecord、业务指纹/版本快照和显式继承已存在 | 按需历史召回、版本化摘要及变更请求在 2B/5 |
| 讨论 | runDiscussion 按参与者循环咨询，boundedConsultations 控制并发 | 缺持久化话题/委派、主 Agent 实质综合与中途补充生命周期，阶段 3 |
| 确认与恢复 | TaskBrief 确认、恢复 checkpoint、工作流选择已存在 | 完整文档 hash/版本绑定及启动握手收敛，阶段 4 |
| 停止 | LogicalOperation 与 SessionStopRequest 持久化，固定目标、可信回执、pending_sync 屏障已实现 | 新生命周期、统一后台工作注册及 generation 防回填，阶段 1 |
| 普通删除 | Sessions.delete 先取消、等待，再清理会话目录/记录并 deleteSessionData | 仍是物理删除，不可恢复；阶段 1 必须替换，不能本轮改文案假装已可恢复 |
| 持久化 | 在线 scoped mutation 及相关集合锁已存在；维护全局 CAS 继续保留 | 新生命周期/策略/讨论 projection 必须同步 file/PostgreSQL，按阶段追加迁移 |
| 记忆 | SummaryMemoryCheckpoint 阶段检查点与 MemoryService 关键词检索 | 字符串累加/限条不能处理所有矛盾与失效；阶段 2B |
| Token | 已有输入估算/预算，estimateTokens 使用字符数/4 | adapter 最终请求和工具循环计数、累计额度跨实例预留在 2A |
| 缓存 | workspace revision 索引缓存；Claude parser 提取 cacheRead/cacheWrite | 四层 key、依赖失效、容量、成本归一化在 2C |
| 双端 | 共享 session/event stores，桌面独立 renderer | 新事件/API 同步接入但不覆盖 Web 样式；各阶段分别补验证 |

源码依据：

- [Agent 目录](../../apps/server/src/modules/agents/agent-catalog.service.ts)
- [消息入口](../../apps/server/src/modules/message-routing/message-ingress.service.ts)
- [语义路由](../../apps/server/src/modules/intent-recognition/semantic-intent-router.service.ts)
- [需求状态](../../apps/server/src/modules/context-management/context-management.service.ts)
- [编排/摘要](../../apps/server/src/modules/orchestrator/orchestrator.service.ts)
- [会话删除/停止](../../apps/server/src/modules/sessions/sessions.service.ts)
- [逻辑操作](../../apps/server/src/modules/runtimes/logical-operation-store.ts)
- [停止聚合](../../apps/server/src/modules/runtimes/session-stop-state-store.ts)
- [持久化](../../apps/server/src/modules/persistence/persistence.service.ts)
- [缓存](../../apps/server/src/modules/workspaces/workspace-index/workspace-index-cache.ts)

## 2. 会话工作句柄盘点与阶段 1 接入清单

| 当前工作 | 当前归属/入口 | 后续必须补强 |
| --- | --- | --- |
| brief 生成 | Sessions.briefGenerationRuns / briefGenerationSeqBySession 按 sessionId | 内存代次改为持久化 lifecycle fencing，保留现有取消 |
| 意图识别 | intentRoutingRuns、controllers、retryTimers 按 sessionId；记录有租约 | 删除准入持久化，已排队/迟到分类不能恢复旧会话 |
| FollowUp 规划 | followUpPlanningRuns 按 sessionId | 同生命周期注册；暂停/删除后提交检查 generation |
| 本地执行驱动 | ExecutionService.running 按 sessionId | 领取与回调读取当前 lifecycle，不只依靠 Map |
| 队列 worker | ExecutionQueue abortControllers 按 sessionId；Job 带 sessionId/briefId/dataEpoch | 新增工作资格/策略版本；多进程取消不能只靠同进程 controller |
| Runtime 调用 | RuntimeService supervised 按 Session/Invocation；LogicalOperation 持久化 | 同一锁域下生命周期准入与 reservation，保留未知停止屏障 |
| Local Runtime 连接 | clients 按 deviceId 共享，activeInvocations 按 invocationId | 只取消目标调用，不关闭共享设备连接/进程 |
| Codex/Claude 适配 | streamingHandles 按 invocationId，CompiledAgentIdentity 已快照化 | 纳入上下文代次，避免按 Agent 复用 CLI 历史 |
| 摘要/动态委派 | 当前摘要为编排内同步创建，持久化委派尚未实现 | 阶段 1 注册/取消接口留扩展口，2B/3 接入，不提前声称已覆盖未来模块 |
| 工作区写回/事件 | 由对应领域服务维护文件/事件状态 | 删除/恢复代次检查、迟到候选禁止写回，可信回执审计仍可核对 |

根目录含大量既有未提交变更。本次不回滚、不整批格式化、不替换已有停止/持久化实现。当前发现的上述差距均有负责阶段，不在阶段 0 顺手修改业务行为。

## 3. 合同变更清单

本阶段 implemented：

- `CollaborationExecutionIdentity` 与 scope 校验、无分隔符碰撞的身份 key。
- 固定 `COLLABORATION_ACTION_OWNERS` 及角色归属校验。
- `CollaborationMessageTarget`、`RequirementConfirmationBinding`、`CollaborationWorkflowStartBinding`。
- `CollaborationLifecycleSnapshot` 与 fail-closed 准入资格校验。
- `CollaborationPolicySnapshot`、有限参数、深冻结及显式升级兼容校验。
- 所有类型通过 shared index 导出；现有 SessionDetail/InvocationPlan 必填结构没有改变。

后续 deferred：所有 API、事件联合类型、数据库 projection/迁移、服务器实际 gate、CLI 参数和 UI 开关。合同定义的 state/type 并不表示业务流程已经可用。

## 4. 迁移顺序及回退检查表

1. 阶段 1 在现有迁移序列后追加 lifecycle/策略存储，保证 file backend 对等；本阶段没有 schema 变更。
2. 先部署新记录的兼容读与能力声明，再切换新记录写入；没有声明支持的旧 writer/worker 不可接管新策略会话。
3. 存量会话无新快照时属于 legacy 策略，不自动写成 active；正在执行的保持原策略直到停稳或完成。
4. 用户显式升级前核对 dataEpoch、活动调用、可信停止、目录和未合并产物，确认后固定新策略快照。
5. 生命周期/策略/需求版本与事件 outbox 原子提交，外部模型与 CLI 调用在提交之后执行；事务重试不重播副作用。
6. 回退先停新准入，保留新记录和停止屏障；旧代码不能解释时向前修复，禁止删墓碑/清空停止数据来解阻塞。
7. 普通删除改为可恢复之后，不允许回退到旧物理删除路径处理该会话；永久清理是后续明确授权的维护操作。

实际发布、数据库迁移和回退演练在阶段 1/6 执行；本阶段只是冻结步骤与合同测试，未宣称已完成运行环境演练。

## 5. 阶段交接与风险裁决

- 产品语义没有新增待用户裁决项；按既定主 Agent、先确认再选流程、按需成员选择、可恢复删除执行。
- 生产阈值不在阶段 0 选定；已冻结有限参数结构，相关阶段按模型/环境配置并校验，不允许空值意味着无限预算。
- 缓存作为可关闭优化，不是讨论正确性的必需运行开关；阶段实施依赖和运行特性依赖分开。
- 现有 API 没有登录认证，本次不把角色矩阵包装成用户权限认证；未来权限功能需独立需求。
- 阶段 1 的入口安全职责明确，不允许把阶段 0 纯函数测试当作多进程停止/可恢复删除已完成。
- 独立 PostgreSQL、双端业务 E2E、真实模型和生产发布未在本阶段运行；后续必须补证。

## 6. 可复现基线命令

从仓库根目录执行，以下 server 测试使用 file/mock fixture，不连接业务数据库或真实模型：

```powershell
node node_modules/tsx/dist/cli.mjs --test packages/shared/src/collaboration-contracts.spec.ts
npm run test -w @agent-cluster/shared
node node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json --test apps/server/src/modules/agents/system-agent-runtime-policy.service.spec.ts apps/server/src/modules/intent-recognition/deterministic-command-guard.service.spec.ts apps/server/src/modules/intent-recognition/semantic-intent-router.service.spec.ts apps/server/src/modules/context-management/context-management.service.spec.ts apps/server/src/modules/runtimes/logical-operation-store.spec.ts apps/server/src/modules/persistence/persistence-scoped-mutation.spec.ts
npm run typecheck
npm run test:harness:main-agent-phase0
```

具体数量与执行结果在阶段 0 Checklist 登记；旧专项通过证据只作为背景，不替代本轮输出。
