# Design Docs

本目录存放系统设计、专题设计和界面规范。

- `agent-cluster-system-design-v1.md`：总体系统设计。
- `agent-collaboration-target-design-v1.md`：群聊 Agent 任务拆解与协作执行的目标态设计。
- `workspace-aware-chat-agent-design-v1.md`：工作区感知聊天 Agent 专题设计。
- `context-router-target-design-v1.md`：支撑群聊协作的 Codex 式上下文路由与最小证据编排设计。
- `coordinator-controlled-routing-design-v1.md`：Coordinator 中心流转、子 Agent 建议交接和后续自动流转预留设计。
- `agent-profile-markdown-skill-tool-model-decoupling-design-v1.md`：Agent Markdown 能力编辑、Skill/Tool 引用编排、Session 级模型选择与后续可视化工作流路线。
- `multica-refactor-development-design-v1.md`：Multica 对标改造（R1–R7）开发设计——运行时流式协议、活性看门狗、ActorRef、Session Resumption、workdir brief、Skill 通道的接口/时序/数据/分期与验证矩阵。
- `multica-refactor-completion-system-design-v1.md`：Multica 对标补全实施系统设计，定义 RunHandle、Runtime Session、Actor 双写、Workdir Brief、Skill 与 Autopilot；当前状态为已实现并完成受控环境验证。
- `workspace-aware-context-v2-integration-closure-v1.md`：Context v2 主链路闭环、Agent 动态执行目标、Workspace Provider、Browser WebSocket Broker 与兼容边界。
- `local-and-server-runtime-workspace-separation-discussion-result-v1.md`：浏览器本地 Runtime、服务器 Runtime、业务工作区归属、平台控制面隔离及实施验收结论。
- `workspace-index-first-on-demand-context-system-design-v1.md`：工作目录快速绑定、Provider 侧增量索引和 Context v2 按需取证；旧单活动 Lease 章节仅保留历史背景。
- `workspace-multi-session-isolation-writeback-v1.md`：同目录多活动 Session、Git/non-Git 隔离、自动写回、三方合并和冲突恢复的权威设计。
- `context-pipeline-v2-only-agent-decoupling-system-design-v1.md`：Context Pipeline v2 单轨、Agent/Profile/Skill/Tool/Runtime 解耦及“活动数据零保留 + 外部加密只读归档”cutover 的权威系统设计。
- `context-v2-session-evidence-remediation-development-design-v1.md`：旧会话可见、架构 Evidence 为空、补读去重与加密只读归档的修复设计和验证矩阵。
- `user-file-revision-multi-agent-processing-system-design-v1.md`：用户直接修改原文件后，由系统确定性 Diff、默认 Receiver Agent 分派一个或多个 Agent、汇总候选 ChangeSet 并经用户确认安全写回的系统设计。
- `user-file-revision-candidate-iteration-development-design-v2.md`：文件修订候选版本循环的目标开发设计；候选只在统一产物编辑器展示和修改，下一轮内部比较上一候选与当前用户稿，由默认 Receiver 生成唯一候选，最终确认后才写回 Workspace。
- `workflow-management-and-runtime-system-design-v1.md`：工作流 Catalog、低代码创建器、三类节点、独立 Runtime、版本快照、幂等恢复与迁移设计。
- `ui-style-guide-v1.md`：前端界面风格规范。

建议阅读顺序：

1. `agent-cluster-system-design-v1.md`
2. `agent-collaboration-target-design-v1.md`
3. `workspace-aware-chat-agent-design-v1.md`
4. `context-router-target-design-v1.md`
5. `coordinator-controlled-routing-design-v1.md`
6. `ui-style-guide-v1.md`

## Additional Docs

- `codex-style-agent-collaboration-architecture-v1.md`: Pluggable Engineering Runtime collaboration architecture, with Codex as the first/default implementation and token-budget guardrails.
- `execution-termination-model-v1.md`: Structured cancellation, timeout, supersession, maintenance, shutdown, and recovery semantics.
