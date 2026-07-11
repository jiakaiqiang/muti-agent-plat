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
