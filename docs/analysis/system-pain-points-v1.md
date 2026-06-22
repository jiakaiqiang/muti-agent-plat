# Agent Cluster 系统痛点分析 v1

> 更新时间：2026-06-22  
> 分析依据：`docs/product/agent-cluster-prd-v1.md`、`docs/analysis/feature-inventory-and-status-v1.md`、`docs/roadmap/unfinished-tasks-v2.md`  
> 分析维度：用户体验、技术债务、功能完整性、可扩展性

## 总体结论

Agent Cluster 当前已从 v1 dry-run 演示闭环推进到"真实优先、后台执行、可恢复、可观测"的 v1+ 状态，但仍存在显著痛点阻碍其成为生产级真实研发平台。

**最阻碍用户使用的 P0 痛点**：
- 真实 Runtime 缺失（Codex/Claude/Human/MCP）
- 工作区写回缺少 diff 审阅

**最阻碍系统扩展的 P1 痛点**：
- PostgreSQL JSONB 结构
- 任务执行串行化
- Agent/Runtime 耦合不清晰

---

## 一、用户体验痛点

### 1. 核心协作能力缺失 — 真实 Runtime 未接入

**优先级**：P0  
**当前表现**：用户发起编码任务后，系统只能通过 Mock Runtime 或 Generic LLM 返回模拟结果，无法真正调用 Codex、Claude Code 等成熟 coding agent 完成代码修改、测试执行、仓库读取等真实研发任务。PRD 承诺的"支持 Codex、Claude Code 等成熟 agent"完全落空。  
**改进方向**：优先实现 Codex Runtime 和 Claude Code Runtime 适配器，保留当前注册表失败语义和审计日志，在 workspace sandbox 和用户确认齐备后逐项开启真实工具。

### 2. 工作区写回缺少变更审阅

**优先级**：P0  
**当前表现**：用户确认执行后，fileChanges 会直接写回本地或 server-local 目录，缺少 before/after diff 对比界面。用户无法在写入前精确审查每个文件的变更内容、冲突检测和逐文件确认，容易误覆盖本地修改。  
**改进方向**：前端增加 diff 审阅组件，展示变更前后对比、高亮冲突行、支持逐文件接受/拒绝，并在应用前生成 checkpoint。

### 3. 飞书通知仍为 dry-run 草稿

**优先级**：P1  
**当前表现**：用户确认"完成后发送飞书通知"，系统只生成 `feishu_draft` artifact 和确认卡，确认后记录 dry-run 事件，实际不会发送。用户以为通知已发出，但团队没有收到任何消息。  
**改进方向**：增加真实飞书发送 adapter，保持显式确认和失败回滚，记录发送状态和 webhook 响应。

### 4. 执行中用户插话处理不完整

**优先级**：P1  
**当前表现**：虽然有 User Message Router 雏形和影响范围判断，但执行中的补充需求、新增约束、纠偏消息的处理路径仍不稳定。用户在执行中说"不要改数据库"，系统可能未暂停相关任务或未更新任务契约，导致继续按旧方案执行。  
**改进方向**：完善 Coordinator 对执行中消息的解释和路由逻辑，确保涉及范围/约束/验收标准变化时强制暂停相关任务、重新生成任务契约并请求用户确认。

### 5. RAG 知识召回质量有限

**优先级**：P1  
**当前表现**：用户上传项目规范、接口文档、业务规则到 RAG 知识库后，系统只做关键词匹配检索，大规模知识库召回质量差。Agent 引用的知识片段经常不相关或遗漏关键信息。  
**改进方向**：接入 embeddings/pgvector，支持语义检索，并增加检索质量与权限测试。

---

## 二、技术债务痛点

### 1. PostgreSQL 仍是 JSONB 单 key collection

**优先级**：P1  
**当前表现**：sessions、events、tasks、artifacts、runtime_invocations 全部存储在一个 JSONB 字段里，难以做复杂查询、索引、关联分析和审计。PRD 设计的细粒度关系表（15 节数据模型）完全未落地。  
**改进方向**：编写 migration 拆分为规范化关系表，支持 event 时间索引、task 依赖查询、artifact 分类统计和 runtime 成本分析。

### 2. 任务执行是串行 ready task 循环

**优先级**：P1  
**当前表现**：`runPipeline` 每次只选一个 ready task 执行，多 Agent 并行度有限。`claimed` 状态定义了但少用，BullMQ 模式下也未按任务粒度入队。  
**改进方向**：在 BullMQ 模式下按任务粒度入队，补并发认领和幂等锁，提升多 Agent 并行执行效率。

### 3. 架构分析特化逻辑混在通用编排

**优先级**：P2  
**当前表现**：`OrchestratorService` 中硬编码了"架构分析""项目分析"等特定需求措辞判断，触发特殊工作区分析产物路径。通用编排模块膨胀，难以扩展新场景。  
**改进方向**：抽成可配置模板或专题 workflow 定义，通过 taskDomain/taskIntent 路由，避免通用 orchestrator 承载业务逻辑。

### 4. Runtime invocation 缺少结构化审计和成本追溯

**优先级**：P2  
**当前表现**：虽然有 `runtime_invocation_logged` 事件和 debug API，但 event metadata 结构松散，缺少独立的 invocations 表。无法按 agent、runtime 类型、时间范围聚合 token 消耗和成本。  
**改进方向**：在数据库 migration 中新增 `capability_invocations` 表（PRD 15.12），记录每次调用的输入输出摘要、token、cost、risk_level，支持成本报表和审计。

### 5. BullMQ 与 in-process 执行路径并存但未统一

**优先级**：P2  
**当前表现**：`ENABLE_BULLMQ` 开关控制两条执行路径，in-process 模式下持有 `AbortController`，BullMQ 模式下用 job id 幂等。两条路径的取消、恢复、token 记录逻辑有差异，增加维护成本。  
**改进方向**：长期统一到 BullMQ 路径，in-process 模式仅保留测试和本地开发场景，确保取消/恢复/token 逻辑一致。

---

## 三、功能完整性痛点

### 1. Human Runtime 未实现 — 无法等待人工确认

**优先级**：P0  
**当前表现**：PRD 定义的 Human Runtime 用于"等待用户确认或人工输入"（3.3 节），但当前只有预留适配器。复杂决策、高风险操作、外部审批等场景无法真正暂停等待人工介入。  
**改进方向**：实现 Human Runtime 适配器，创建 `human_confirmation_requested` 事件和前端确认卡，支持带选项的决策和自由文本输入。

### 2. MCP Tool Runtime 未接入 — 外部能力无法调用

**优先级**：P0  
**当前表现**：PRD 承诺"支持 Agent 调用外部 MCP 工具"（3.3、13 节），但 `mcp_tool` runtime 仍未接入真实执行。用户无法让 Agent 调用外部系统 API、数据库查询、文件操作等 MCP 能力。  
**改进方向**：实现 MCP Tool Runtime 适配器，对接 MCP server 协议，支持 capability 注册、权限检查和 invocation log。

### 3. Agent @ 机制未端到端实现

**优先级**：P1  
**当前表现**：PRD 多处描述 Agent 之间通过 @ 进行联调、评审、依赖交付（7.4、9.3 节），但当前事件流缺少 `agent_mention` 类型，前端输入框没有 @ 选择器，后端也未做 @ 路由逻辑。Agent 协作主要靠任务依赖，缺少即时消息式协作。  
**改进方向**：增加 `agent_mention` 事件类型，前端输入框支持 @Agent 选择，后端 Coordinator 解析 @ 并路由给目标 Agent，记录在事件流中展示。

### 4. 协作流转可视化和工作流模式仅有简版

**优先级**：P1  
**当前表现**：PRD 承诺三种查看模式（2 节、9.5/9.6 节），但当前前端只有群聊视图完整，协作图和工作流视图功能薄弱，缺少 Agent 节点高亮、信息流线、阶段流程图等可视化。  
**改进方向**：基于 collaboration_events 派生 Agent 节点状态、消息气泡、流线关系，实现类似微信群聊流转的协作图和类似 Dify 的工作流图。

### 5. 长期记忆管理未完善 — 缺少跨会话复用和用户偏好管理

**优先级**：P2  
**当前表现**：当前只有 session memory 和偏好确认卡雏形，缺少 project memory、agent memory、tool memory 的管理界面和跨会话检索逻辑（11 节记忆类型）。用户无法查看和管理已沉淀的长期记忆。  
**改进方向**：增加 Memory 管理页面，支持按 scope/project/agent 筛选、编辑、删除、导出记忆，并在 Context Pack 中优先注入相关长期记忆。

---

## 四、可扩展性痛点

### 1. Agent 角色与 Runtime 耦合不清晰

**优先级**：P1  
**当前表现**：虽然 PRD 强调"Agent 身份与模型/Runtime 解耦"（3.2 节），但当前 default agents 定义中包含 `runtimeType`，前端 AgentManager 直接关联 runtime 选择。新增 Agent 角色时需要同时考虑 runtime 配置，扩展性受限。  
**改进方向**：将 runtime 选择抽成 policy 层，Agent 定义只声明能力需求（如需要代码编辑、仓库读取），由 RuntimeRouter 根据能力需求、可用 runtime、预算和风险策略动态路由。

### 2. 任务领域模板不可配置 — 难以扩展非研发场景

**优先级**：P1  
**当前表现**：当前 taskDomain/taskIntent 逻辑硬编码在 OrchestratorService 中，PRD 承诺的产品、运营 Agent 团队模板（5.2、19 节）无法通过配置新增，只能改代码。  
**改进方向**：设计 workflow template schema，支持定义参与 Agent、讨论轮次、任务拆解规则、验收标准模板，通过配置文件或数据库管理，避免核心编排代码膨胀。

### 3. Capability Registry 缺少版本和依赖管理

**优先级**：P2  
**当前表现**：当前能力注册只有名称、描述、风险等级，缺少版本、依赖、兼容性、弃用标记。多个 MCP server 提供同名能力时无法区分，能力升级无法做兼容性检查。  
**改进方向**：增加 capability 版本字段、依赖声明、兼容性矩阵，支持 capability 升级时自动检查受影响会话并提示用户。

### 4. 事件流缺少元数据索引和查询优化

**优先级**：P2  
**当前表现**：collaboration_events 全部存储在 JSONB 中，缺少 type、agent_id、task_id、created_at 索引。会话事件增多后，前端回补事件、按 Agent 过滤、按时间范围查询都会变慢。  
**改进方向**：在 PostgreSQL migration 中为 events 表增加 type、session_id、agent_id、task_id、created_at 的 GIN/BTREE 索引，支持高效过滤和分页。

### 5. 前端状态管理与后端事件流同步逻辑分散

**优先级**：P2  
**当前表现**：前端 Pinia stores（session/agent/event）通过 SSE 和 REST 同步后端状态，但同步逻辑分散在多个组件和 store action 中。事件顺序、重复、丢失处理不一致，难以扩展新事件类型。  
**改进方向**：统一事件流同步中间件，基于 event id 做去重和顺序保证，所有状态派生从单一事件流驱动，新增事件类型只需注册 handler。

---

## 五、优先级建议

### 立即优先（P0 痛点）

1. **实现 Codex/Claude Code Runtime 适配器** — 解决核心协作能力缺失
2. **增加 fileChanges diff 审阅组件** — 防止误覆盖本地文件
3. **实现 Human Runtime** — 支持人工决策环节
4. **接入 MCP Tool Runtime** — 支持外部能力调用

### 短期推进（P1 痛点）

1. **PostgreSQL 数据库规范化** — 拆分为关系表，支持复杂查询
2. **任务级并发调度** — BullMQ 任务粒度入队，提升并行度
3. **解耦 Agent 与 Runtime** — 抽成 policy 层，动态路由
4. **完善执行中用户插话** — 支持动态调整任务契约
5. **pgvector 语义检索** — 提升 RAG 召回质量

### 中期优化（P2 痛点）

1. **统一 BullMQ 与 in-process 执行路径**
2. **Runtime invocation 结构化审计**
3. **Workflow template 配置化**
4. **Capability 版本与依赖管理**
5. **事件流索引优化**

---

## 六、改进路线图

### 阶段一：核心能力补全（2-3 周）

- [ ] Codex Runtime 适配器实现与测试
- [ ] Claude Code Runtime 适配器实现与测试
- [ ] fileChanges diff 审阅前端组件
- [ ] Human Runtime 适配器与确认卡

### 阶段二：技术债务清理（2-3 周）

- [ ] PostgreSQL schema migration（sessions/events/tasks/artifacts）
- [ ] BullMQ 任务级并发调度
- [ ] Agent/Runtime 解耦重构
- [ ] 执行中用户插话完善

### 阶段三：扩展性增强（2-3 周）

- [ ] pgvector 语义检索
- [ ] MCP Tool Runtime 适配器
- [ ] Workflow template schema 设计
- [ ] 事件流索引优化

---

**参考文档**：
- `docs/product/agent-cluster-prd-v1.md`
- `docs/analysis/feature-inventory-and-status-v1.md`
- `docs/roadmap/unfinished-tasks-v2.md`
- `docs/design/agent-cluster-system-design-v1.md`
