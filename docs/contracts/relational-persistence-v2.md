# 关系型持久化合同 v2

本文档是 `agent_cluster` PostgreSQL 关系模型和会话持久化边界的执行合同。数据库表和字段的中文说明以 `relational-schema.ts` 生成的 `COMMENT ON TABLE/COLUMN` 为准；本文件说明使用边界和迁移方法。

## 1. 会话数据边界

一次会话中的事实数据必须先写入数据库，再向 SSE、WebSocket 或 HTTP 响应发布。数据库提交失败时，不发布成功事件，接口由提交拦截器等待 `PersistenceService.flush()` 并返回错误。进程重启后，数据库是恢复事实，不能依赖进程内 Map 或旧 JSON 文件。

写入数据库的内容：

- 会话身份、状态、阶段、进度、参与者和恢复游标；
- 用户消息、Agent 消息、Runtime 事件、工具调用和权限/审批快照；
- Brief、建议任务、正式任务、依赖、补充上下文请求；
- Agent、Skill、Tool、Capability、MCP Server、Workflow 的目录、版本、绑定和流转定义；
- Runtime 调用的冻结输入、输出摘要、错误、Token 使用量和系统证据；
- 记忆、知识库元数据、检索分块、Artifact 元数据和文件变更元数据；
- Outbox、Workflow Effect、迁移审计和恢复所需的幂等键。

保留在本地内容存储或工作区的内容：

- 用户或 Agent 的大段正文、文件正文、变更提案正文；
- Tool stdout/stderr、Runtime 原始输出和知识文档正文；
- 会话中新增、修改、删除文件的实际工作区内容。

本地内容以 SHA-256 内容寻址保存，数据库只保存 `content_objects` 引用、大小、媒体类型、路径和完整性状态。数据库中的 JSONB 仅保存可检索的元数据、脱敏摘要和引用标记，不保存整份文件或整段原始输出。工具参数和结果在入库前递归脱敏，密钥只保存 `secret_ref`，不保存明文。

组合方式：关系记录保存实体关系和生命周期；`source_snapshot` 保存无法拆成稳定列的兼容字段；`content_objects` 保存大正文引用；读取时按外部 ID 重新组装现有 v3 DTO，并由 `ContentReferenceCodec` 从本地内容存储恢复正文。这样既保持现有 API/前端 DTO 不变，也避免把 JSON 文件整体塞进数据库。

## 2. 表职责清单

| 表 | 职责 |
| --- | --- |
| `system_data_metadata` | 数据纪元、合同版本、切换信息 |
| `migration_runs` | 迁移输入、阶段、结果、对账摘要 |
| `migration_errors` | 无法映射或校验失败的数据 |
| `content_objects` | 本地正文的哈希、大小、路径、完整性 |
| `agents` | 所有 Agent 稳定身份和生命周期 |
| `agent_versions` | Agent Profile/Prompt/运行偏好的不可变版本 |
| `skills` | 所有 Skill 稳定身份和生命周期 |
| `skill_versions` | Skill 指令、文件清单和版本 |
| `tools` | 内置、本地、Runtime 原生、MCP Tool 目录 |
| `tool_versions` | Tool Schema、执行配置和版本快照 |
| `mcp_servers` | MCP Server 定义、传输配置、密钥引用 |
| `mcp_server_tools` | MCP Server 发现的 Tool 及版本关联 |
| `capabilities` | Capability 合同、风险和生命周期 |
| `knowledge_bases` | 知识库作用域、所有者和可见性 |
| `agent_skill_bindings` | Agent 版本到 Skill 版本的绑定和顺序 |
| `agent_tool_bindings` | Agent 版本允许的 Tool 版本和策略 |
| `agent_knowledge_bindings` | Agent 版本可检索的知识库及优先级 |
| `capability_tool_bindings` | Capability 到可执行 Tool 的映射 |
| `workflows` | 所有 Workflow 稳定身份、名称、作用域 |
| `workflow_versions` | Workflow 不可变版本和定义哈希 |
| `workflow_nodes` | Workflow 节点、Agent/Tool/审批/条件类型 |
| `workflow_edges` | Workflow 节点条件流转关系 |
| `sessions` | 会话身份、状态、上下文管线和恢复信息 |
| `session_participants` | 用户和冻结 Agent 版本参与关系 |
| `session_status_history` | 会话状态转换历史 |
| `session_progress` | 当前阶段、完成比例和阻塞信息 |
| `collaboration_events` | 聊天时间线和协作事件事实记录 |
| `briefs` | 用户确认的任务简报 |
| `suggested_tasks` | Brief 拆分阶段的建议任务 |
| `tasks` | 正式任务、依赖、负责人、状态和验证 |
| `supplemental_context_requests` | Runtime 补充上下文请求和重试 |
| `memories` | 短期、会话和待确认长期记忆 |
| `knowledge_documents` | 知识文档元数据和正文引用 |
| `knowledge_chunks` | 检索分块和规范化索引文本 |
| `runtime_model_configs` | Runtime 模型配置和加密密钥引用 |
| `runtime_invocations` | Runtime 冻结输入、状态、结果和证据 |
| `tool_invocations` | Tool Executor/MCP Adapter 每次调用 |
| `tool_invocation_authority_snapshots` | 调用时权限、Capability、审批快照 |
| `capability_approvals` | 高风险 Capability/Tool 用户审批 |
| `artifacts` | 交付物、报告、变更提案元数据 |
| `artifact_file_changes` | Artifact 文件操作、哈希和正文引用 |
| `workflow_runs` | Workflow 版本运行实例 |
| `workflow_node_runs` | Workflow 节点每次尝试的状态和结果 |
| `workflow_approvals` | Workflow 审批决定和审计快照 |
| `workflow_effects` | Workflow 业务副作用及可靠执行状态 |
| `autopilots` | 自动运行计划定义 |
| `autopilot_runs` | Autopilot 触发的会话和运行结果 |
| `event_outbox` | 事务提交后的可靠事件发布队列 |
| `cutover_audits` | 数据切换申请、确认和执行结果 |

每张表和每个字段都由 schema manifest 生成中文数据库注释；迁移启动时会检查注释完整性，缺失即失败。

## 3. JSON 迁移策略

`state.v3.json` 的 20 个顶层 collection 均有明确关系映射，迁移前执行 `assertRelationalCollectionsMapped`，未知 collection 直接失败。每个实体保留 `source_snapshot` 或兼容字段，保证旧 DTO 可无损回读；这不是把整个 JSON 作为一列保存。

迁移命令：

```bash
# 只查看结构和注释
$env:DATABASE_URL='postgres://...'; npm run db:migrate

# 查看源文件清单、数量和每个 collection 的 SHA-256
npm run migrate:relational -- inventory --source .cache/agent-cluster/state.v3.json

# 预演，不写数据库
npm run migrate:relational -- dry-run --source .cache/agent-cluster/state.v3.json

# 显式确认后执行原子迁移
npm run migrate:relational -- apply --source .cache/agent-cluster/state.v3.json --confirm

# 逐 collection 对账
npm run migrate:relational -- verify --source .cache/agent-cluster/state.v3.json

# 从数据库导出可回滚的 JSON 快照
npm run migrate:relational -- rollback-export --output .cache/agent-cluster/rollback.json
```

默认情况下 `apply` 拒绝已有业务数据的目标库，避免误覆盖。确需合并或重做迁移时，必须显式提供回滚快照路径：

```bash
npm run migrate:relational -- apply --source .cache/agent-cluster/state.v3.json --confirm --allow-non-empty --output .cache/agent-cluster/rollback-before-apply.json
```

该命令会在写入前导出目标状态，并在同一数据库事务中重建、读取和校验全部 collection；校验失败会回滚。迁移使用 PostgreSQL advisory lock、迁移 checksum、事务和 `migration_runs` 审计；应用启动时会在关系库为空且发现旧 `agent_cluster_collections` 数据时自动导入一次，之后旧表只读、不再作为新写入目标。生产切换顺序是：备份文件和数据库、`dry-run`、空库 `apply --confirm`（或非空库带回滚快照）、`verify`、启动应用、观察恢复和事件发布。
