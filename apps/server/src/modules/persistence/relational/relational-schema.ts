export type RelationalColumnDefinition = {
  name: string;
  sql: string;
  comment: string;
};

export type RelationalTableDefinition = {
  name: string;
  comment: string;
  columns: RelationalColumnDefinition[];
  constraints?: string[];
  indexes?: string[];
};

const table = (
  name: string,
  comment: string,
  columns: RelationalColumnDefinition[],
  constraints: string[] = [],
  indexes: string[] = []
): RelationalTableDefinition => ({ name, comment, columns, constraints, indexes });

const column = (name: string, sql: string, comment: string): RelationalColumnDefinition => ({ name, sql, comment });

export const RELATIONAL_SCHEMA_NAME = 'agent_cluster';

export const SCHEMA_MIGRATIONS_TABLE = table(
  'schema_migrations',
  '记录关系型数据库结构迁移的执行版本，防止同一迁移重复执行。',
  [
    column('version', 'integer primary key', '迁移版本号，按整数递增且全局唯一。'),
    column('name', 'text not null', '迁移名称，用于运维识别本次结构变更。'),
    column('checksum', 'text not null', '迁移 SQL 的 SHA-256 校验值，用于识别已执行迁移被篡改。'),
    column('applied_at', 'timestamptz not null default now()', '迁移成功提交到数据库的时间。')
  ]
);

export const RELATIONAL_TABLES: RelationalTableDefinition[] = [
  table('system_data_metadata', '保存当前数据库数据纪元、数据合同版本和最近一次切换信息。', [
    column('singleton_key', "text primary key default 'current'", '单例记录键，当前数据固定为 current。'),
    column('data_schema_version', 'integer not null', '当前业务数据结构版本。'),
    column('pipeline_version', 'text not null', '当前上下文管线版本。'),
    column('data_epoch', 'text not null', '隔离不同数据代际的唯一纪元标识。'),
    column('cutover_at', 'timestamptz not null', '本数据纪元完成切换的时间。'),
    column('cutover_audit_id', 'text not null', '产生本数据纪元的切换审计记录外部标识。'),
    column('updated_at', 'timestamptz not null default now()', '元数据最后更新时间。')
  ]),
  table('migration_runs', '记录一次文件到关系数据库迁移的输入、阶段、结果和对账摘要。', [
    column('id', 'bigint generated always as identity primary key', '迁移运行内部主键。'),
    column('external_id', 'text not null unique', '迁移运行对外稳定标识。'),
    column('source_path', 'text not null', '源状态文件的规范化路径。'),
    column('source_sha256', 'text not null', '源状态文件内容的 SHA-256。'),
    column('mode', 'text not null', '运行模式，例如 inventory、dry_run、apply、verify 或 rollback_export。'),
    column('status', 'text not null', '迁移运行状态。'),
    column('summary', "jsonb not null default '{}'::jsonb", '不含文件正文的迁移数量、校验值和诊断摘要。'),
    column('started_at', 'timestamptz not null default now()', '迁移开始时间。'),
    column('completed_at', 'timestamptz', '迁移结束时间。'),
    column('created_by', 'text', '发起迁移的操作者标识。')
  ], [], ['create index if not exists migration_runs_source_idx on agent_cluster.migration_runs (source_sha256, mode)']),
  table('migration_errors', '保存迁移过程中无法映射或校验失败的单条数据，供修复和重跑。', [
    column('id', 'bigint generated always as identity primary key', '迁移错误内部主键。'),
    column('migration_run_id', 'bigint not null references agent_cluster.migration_runs(id) on delete cascade', '所属迁移运行内部主键。'),
    column('collection_key', 'text not null', '错误数据在源文件中的 collection 名称。'),
    column('record_key', 'text', '错误数据的源记录标识或数组位置。'),
    column('error_code', 'text not null', '稳定的错误代码。'),
    column('error_message', 'text not null', '可供运维定位问题的错误说明。'),
    column('record_snapshot', 'jsonb', '经过脱敏且不含文件正文的源记录快照。'),
    column('created_at', 'timestamptz not null default now()', '错误被记录的时间。')
  ], [], ['create index if not exists migration_errors_run_idx on agent_cluster.migration_errors (migration_run_id)']),
  table('content_objects', '登记存放在 LocalContentStore 或 Workspace 中的大内容和文件正文。', [
    column('id', 'bigint generated always as identity primary key', '内容对象内部主键。'),
    column('external_id', 'text not null unique', '内容对象对外稳定标识。'),
    column('sha256', 'text not null', '内容字节的 SHA-256，用于寻址、去重和完整性校验。'),
    column('size_bytes', 'bigint not null check (size_bytes >= 0)', '内容字节长度。'),
    column('media_type', 'text not null', '内容 MIME 类型。'),
    column('storage_type', 'text not null', '存储类型，取 local_content 或 workspace。'),
    column('storage_path', 'text not null', '相对持久卷或工作区根目录的安全路径。'),
    column('original_name', 'text', '内容原始文件名或逻辑名称。'),
    column('integrity_status', "text not null default 'verified'", '最近一次完整性检查状态。'),
    column('created_at', 'timestamptz not null default now()', '内容对象首次登记时间。'),
    column('last_verified_at', 'timestamptz', '最近一次哈希校验时间。'),
    column('deleted_at', 'timestamptz', '内容对象进入待回收状态的时间。')
  ], ['unique (sha256, storage_type)'], ['create index if not exists content_objects_gc_idx on agent_cluster.content_objects (deleted_at) where deleted_at is not null']),
  table('agents', '维护系统中所有 Agent 的稳定身份、作用域和生命周期。', [
    column('id', 'bigint generated always as identity primary key', 'Agent 内部主键。'),
    column('external_id', 'text not null unique', '兼容现有合同的 Agent 外部标识。'),
    column('agent_key', 'text not null', 'Agent 在所属作用域内稳定且可读的业务键。'),
    column('name', 'text not null', 'Agent 展示名称。'),
    column('description', 'text', 'Agent 用途说明。'),
    column('agent_type', 'text not null', 'Agent 类型或角色类别。'),
    column('scope_type', "text not null default 'system'", 'Agent 作用域类型，例如 system、project 或 tenant。'),
    column('scope_id', 'text', 'Agent 所属作用域标识，系统级 Agent 为空。'),
    column('status', "text not null default 'enabled'", 'Agent 生命周期状态。'),
    column('current_version_id', 'bigint', '当前发布版本内部主键，在版本表创建后补充外键。'),
    column('created_at', 'timestamptz not null default now()', 'Agent 创建时间。'),
    column('updated_at', 'timestamptz not null default now()', 'Agent 最后更新时间。'),
    column('deleted_at', 'timestamptz', 'Agent 软删除时间。')
  ], ['unique (scope_type, scope_id, agent_key)']),
  table('agent_versions', '保存 Agent 的不可变版本，包括 Profile、Prompt、运行偏好和动态配置。', [
    column('id', 'bigint generated always as identity primary key', 'Agent 版本内部主键。'),
    column('agent_id', 'bigint not null references agent_cluster.agents(id)', '所属 Agent 内部主键。'),
    column('version', 'integer not null check (version > 0)', 'Agent 递增版本号。'),
    column('status', 'text not null', '版本状态，例如 draft、published 或 deprecated。'),
    column('profile_markdown', 'text', '该版本 Agent Profile Markdown 正文。'),
    column('system_prompt', 'text', '该版本固定系统提示词。'),
    column('runtime_preference', "jsonb not null default '{}'::jsonb", '该版本动态 Runtime 选择偏好，不包含密钥。'),
    column('configuration', "jsonb not null default '{}'::jsonb", '尚未关系化且不包含文件正文的 Agent 扩展配置。'),
    column('definition_hash', 'text not null', '该版本规范化定义的 SHA-256。'),
    column('created_at', 'timestamptz not null default now()', '版本创建时间。'),
    column('published_at', 'timestamptz', '版本发布时间。'),
    column('created_by', 'text', '创建该版本的操作者标识。')
  ], ['unique (agent_id, version)']),
  table('skills', '维护系统中所有 Skill 的稳定身份、来源和生命周期。', [
    column('id', 'bigint generated always as identity primary key', 'Skill 内部主键。'),
    column('external_id', 'text not null unique', '兼容现有合同的 Skill 外部标识。'),
    column('skill_key', 'text not null', 'Skill 在所属作用域内的稳定业务键。'),
    column('name', 'text not null', 'Skill 展示名称。'),
    column('description', 'text', 'Skill 用途说明。'),
    column('source_type', 'text not null', 'Skill 来源类型，例如 builtin、local 或 imported。'),
    column('source_uri', 'text', 'Skill 来源路径或仓库地址。'),
    column('scope_type', "text not null default 'system'", 'Skill 作用域类型。'),
    column('scope_id', 'text', 'Skill 所属作用域标识。'),
    column('status', "text not null default 'enabled'", 'Skill 生命周期状态。'),
    column('current_version_id', 'bigint', '当前发布版本内部主键，在版本表创建后补充外键。'),
    column('created_at', 'timestamptz not null default now()', 'Skill 创建时间。'),
    column('updated_at', 'timestamptz not null default now()', 'Skill 最后更新时间。'),
    column('deleted_at', 'timestamptz', 'Skill 软删除时间。')
  ], ['unique (scope_type, scope_id, skill_key)']),
  table('skill_versions', '保存 Skill 指令、文件清单和配置的不可变版本。', [
    column('id', 'bigint generated always as identity primary key', 'Skill 版本内部主键。'),
    column('skill_id', 'bigint not null references agent_cluster.skills(id)', '所属 Skill 内部主键。'),
    column('version', 'integer not null check (version > 0)', 'Skill 递增版本号。'),
    column('status', 'text not null', '版本状态。'),
    column('content', 'text not null', 'Skill 主指令正文。'),
    column('files_manifest', "jsonb not null default '[]'::jsonb", 'Skill 附属文件路径、哈希和内容引用清单。'),
    column('configuration', "jsonb not null default '{}'::jsonb", '不包含文件正文和密钥的 Skill 扩展配置。'),
    column('definition_hash', 'text not null', '该版本规范化定义的 SHA-256。'),
    column('created_at', 'timestamptz not null default now()', '版本创建时间。'),
    column('published_at', 'timestamptz', '版本发布时间。'),
    column('created_by', 'text', '创建该版本的操作者标识。')
  ], ['unique (skill_id, version)']),
  table('tools', '维护系统中所有内置、本地、Runtime 原生和 MCP 工具的稳定身份。', [
    column('id', 'bigint generated always as identity primary key', 'Tool 内部主键。'),
    column('external_id', 'text not null unique', 'Tool 对外稳定标识。'),
    column('tool_key', 'text not null', 'Tool 在所属作用域内的稳定业务键。'),
    column('name', 'text not null', 'Tool 展示名称。'),
    column('description', 'text', 'Tool 用途说明。'),
    column('tool_type', 'text not null', '工具类型，例如 builtin、local、mcp 或 runtime_native。'),
    column('provider', 'text', '工具提供方或适配器名称。'),
    column('scope_type', "text not null default 'system'", 'Tool 作用域类型。'),
    column('scope_id', 'text', 'Tool 所属作用域标识。'),
    column('risk_level', "text not null default 'low'", '工具风险等级。'),
    column('approval_policy', "text not null default 'none'", '工具调用审批策略。'),
    column('status', "text not null default 'enabled'", 'Tool 生命周期状态。'),
    column('current_version_id', 'bigint', '当前发布版本内部主键，在版本表创建后补充外键。'),
    column('created_at', 'timestamptz not null default now()', 'Tool 创建时间。'),
    column('updated_at', 'timestamptz not null default now()', 'Tool 最后更新时间。'),
    column('deleted_at', 'timestamptz', 'Tool 软删除时间。')
  ], ['unique (scope_type, scope_id, tool_key)']),
  table('tool_versions', '保存 Tool 输入输出 Schema、执行配置和版本快照。', [
    column('id', 'bigint generated always as identity primary key', 'Tool 版本内部主键。'),
    column('tool_id', 'bigint not null references agent_cluster.tools(id)', '所属 Tool 内部主键。'),
    column('version', 'integer not null check (version > 0)', 'Tool 递增版本号。'),
    column('status', 'text not null', '版本状态。'),
    column('input_schema', "jsonb not null default '{}'::jsonb", '工具输入 JSON Schema。'),
    column('output_schema', "jsonb not null default '{}'::jsonb", '工具输出 JSON Schema。'),
    column('execution_config', "jsonb not null default '{}'::jsonb", '不包含密钥的执行器配置。'),
    column('definition_hash', 'text not null', '该版本规范化定义的 SHA-256。'),
    column('created_at', 'timestamptz not null default now()', '版本创建时间。'),
    column('published_at', 'timestamptz', '版本发布时间。'),
    column('created_by', 'text', '创建该版本的操作者标识。')
  ], ['unique (tool_id, version)']),
  table('mcp_servers', '维护 MCP Server 定义、传输配置和密钥引用。', [
    column('id', 'bigint generated always as identity primary key', 'MCP Server 内部主键。'),
    column('external_id', 'text not null unique', 'MCP Server 对外稳定标识。'),
    column('server_key', 'text not null unique', 'MCP Server 稳定业务键。'),
    column('name', 'text not null', 'MCP Server 展示名称。'),
    column('transport_type', 'text not null', '连接传输类型，例如 stdio、http 或 sse。'),
    column('endpoint', 'text', '远程 MCP 地址；stdio 类型可为空。'),
    column('command', 'text', 'stdio MCP 启动命令，不包含密钥。'),
    column('arguments', "jsonb not null default '[]'::jsonb", 'stdio MCP 启动参数，不包含密钥。'),
    column('secret_ref', 'text', '外部 Secret Manager 或环境变量中的密钥引用。'),
    column('status', "text not null default 'enabled'", 'MCP Server 生命周期状态。'),
    column('created_at', 'timestamptz not null default now()', 'MCP Server 创建时间。'),
    column('updated_at', 'timestamptz not null default now()', 'MCP Server 最后更新时间。'),
    column('deleted_at', 'timestamptz', 'MCP Server 软删除时间。')
  ]),
  table('mcp_server_tools', '关联 MCP Server 暴露的 Tool 版本并保存发现快照。', [
    column('id', 'bigint generated always as identity primary key', 'MCP Server Tool 关联内部主键。'),
    column('mcp_server_id', 'bigint not null references agent_cluster.mcp_servers(id)', '所属 MCP Server 内部主键。'),
    column('tool_version_id', 'bigint not null references agent_cluster.tool_versions(id)', '关联 Tool 版本内部主键。'),
    column('provider_tool_name', 'text not null', 'MCP Server 返回的原始工具名称。'),
    column('discovered_at', 'timestamptz not null default now()', '本工具最近一次被发现的时间。'),
    column('status', "text not null default 'active'", 'MCP 工具发现状态。')
  ], ['unique (mcp_server_id, provider_tool_name)']),
  table('capabilities', '维护 Agent 能力定义、风险级别和输入输出合同。', [
    column('id', 'bigint generated always as identity primary key', 'Capability 内部主键。'),
    column('external_id', 'text not null unique', '兼容现有合同的 Capability 外部标识。'),
    column('capability_key', 'text not null unique', 'Capability 稳定业务键。'),
    column('kind', 'text not null', '能力种类，例如 internal、tool、mcp 或 connector。'),
    column('name', 'text not null', 'Capability 展示名称。'),
    column('description_markdown', 'text', 'Capability 说明 Markdown。'),
    column('usage_markdown', 'text', 'Capability 使用说明 Markdown。'),
    column('input_schema', "jsonb not null default '{}'::jsonb", 'Capability 输入 JSON Schema。'),
    column('output_schema', "jsonb not null default '{}'::jsonb", 'Capability 输出 JSON Schema。'),
    column('risk_level', 'text not null', 'Capability 风险等级。'),
    column('status', 'text not null', 'Capability 生命周期状态。'),
    column('system_owned', 'boolean not null default false', '是否为系统内置且受保护的 Capability。'),
    column('source_snapshot', "jsonb not null default '{}'::jsonb", 'Capability 未被核心关系字段覆盖的单实体兼容快照。'),
    column('created_at', 'timestamptz not null default now()', 'Capability 创建时间。'),
    column('updated_at', 'timestamptz not null default now()', 'Capability 最后更新时间。'),
    column('deleted_at', 'timestamptz', 'Capability 软删除时间。')
  ]),
  table('knowledge_bases', '维护系统、项目、会话、Agent 或角色范围的知识库。', [
    column('id', 'bigint generated always as identity primary key', '知识库内部主键。'),
    column('external_id', 'text not null unique', '兼容现有合同的知识库外部标识。'),
    column('name', 'text not null', '知识库名称。'),
    column('description', 'text', '知识库说明。'),
    column('scope_type', 'text not null', '知识库作用域类型。'),
    column('scope_id', 'text', '知识库所属作用域标识。'),
    column('owner_id', 'text not null', '知识库所有者标识。'),
    column('visibility', 'text not null', '知识库可见性。'),
    column('embedding_model', 'text not null', '知识库使用的嵌入模型。'),
    column('source_snapshot', "jsonb not null default '{}'::jsonb", '知识库未被核心关系字段覆盖的单实体兼容快照。'),
    column('created_at', 'timestamptz not null default now()', '知识库创建时间。'),
    column('updated_at', 'timestamptz not null default now()', '知识库最后更新时间。'),
    column('deleted_at', 'timestamptz', '知识库软删除时间。')
  ]),
  table('agent_skill_bindings', '记录特定 Agent 版本绑定的 Skill 版本和注入顺序。', [
    column('id', 'bigint generated always as identity primary key', 'Agent Skill 绑定内部主键。'),
    column('agent_version_id', 'bigint not null references agent_cluster.agent_versions(id) on delete cascade', '绑定的 Agent 版本内部主键。'),
    column('skill_version_id', 'bigint not null references agent_cluster.skill_versions(id)', '绑定的 Skill 版本内部主键。'),
    column('injection_order', 'integer not null default 0', 'Skill 注入 Agent 上下文的顺序。'),
    column('required', 'boolean not null default false', '缺失该 Skill 时是否禁止执行。'),
    column('configuration', "jsonb not null default '{}'::jsonb", '本次绑定的非敏感覆盖配置。'),
    column('created_at', 'timestamptz not null default now()', '绑定创建时间。')
  ], ['unique (agent_version_id, skill_version_id)']),
  table('agent_tool_bindings', '记录特定 Agent 版本允许使用的 Tool 版本和授权策略。', [
    column('id', 'bigint generated always as identity primary key', 'Agent Tool 绑定内部主键。'),
    column('agent_version_id', 'bigint not null references agent_cluster.agent_versions(id) on delete cascade', '绑定的 Agent 版本内部主键。'),
    column('tool_version_id', 'bigint not null references agent_cluster.tool_versions(id)', '绑定的 Tool 版本内部主键。'),
    column('authority_policy', "jsonb not null default '{}'::jsonb", '该 Agent 调用工具时的权限和审批策略。'),
    column('created_at', 'timestamptz not null default now()', '绑定创建时间。')
  ], ['unique (agent_version_id, tool_version_id)']),
  table('agent_knowledge_bindings', '记录特定 Agent 版本可检索的知识库及优先级。', [
    column('id', 'bigint generated always as identity primary key', 'Agent 知识库绑定内部主键。'),
    column('agent_version_id', 'bigint not null references agent_cluster.agent_versions(id) on delete cascade', '绑定的 Agent 版本内部主键。'),
    column('knowledge_base_id', 'bigint not null references agent_cluster.knowledge_bases(id)', '绑定的知识库内部主键。'),
    column('priority', 'integer not null default 0', '知识库检索优先级，值越大优先级越高。'),
    column('created_at', 'timestamptz not null default now()', '绑定创建时间。')
  ], ['unique (agent_version_id, knowledge_base_id)']),
  table('capability_tool_bindings', '将抽象 Capability 映射到一个可执行 Tool 版本。', [
    column('id', 'bigint generated always as identity primary key', 'Capability Tool 绑定内部主键。'),
    column('capability_id', 'bigint not null references agent_cluster.capabilities(id) on delete cascade', 'Capability 内部主键。'),
    column('tool_version_id', 'bigint not null references agent_cluster.tool_versions(id)', '实现该 Capability 的 Tool 版本内部主键。'),
    column('priority', 'integer not null default 0', '多个实现之间的选择优先级。'),
    column('configuration', "jsonb not null default '{}'::jsonb", '本次映射的非敏感执行配置。'),
    column('created_at', 'timestamptz not null default now()', '绑定创建时间。')
  ], ['unique (capability_id, tool_version_id)']),
  table('workflows', '维护系统中所有工作流的稳定身份、名称、作用域和生命周期。', [
    column('id', 'bigint generated always as identity primary key', 'Workflow 内部主键。'),
    column('external_id', 'text not null unique', '兼容现有合同的 Workflow 外部标识。'),
    column('workflow_key', 'text not null', 'Workflow 在所属作用域内的稳定业务键。'),
    column('name', 'text not null', 'Workflow 展示名称。'),
    column('description', 'text', 'Workflow 用途说明。'),
    column('scope_type', "text not null default 'system'", 'Workflow 作用域类型。'),
    column('scope_id', 'text', 'Workflow 所属作用域标识。'),
    column('status', "text not null default 'draft'", 'Workflow 生命周期状态。'),
    column('draft_revision', 'integer not null default 1', '当前草稿 CAS 修订号。'),
    column('draft_snapshot', "jsonb not null default '{}'::jsonb", '文件正文已外置后的当前可编辑草稿兼容快照。'),
    column('current_version_id', 'bigint', '当前发布版本内部主键，在版本表创建后补充外键。'),
    column('created_at', 'timestamptz not null default now()', 'Workflow 创建时间。'),
    column('updated_at', 'timestamptz not null default now()', 'Workflow 最后更新时间。'),
    column('deleted_at', 'timestamptz', 'Workflow 软删除时间。')
  ], ['unique (scope_type, scope_id, workflow_key)']),
  table('workflow_versions', '保存已发布工作流的不可变版本和定义哈希。', [
    column('id', 'bigint generated always as identity primary key', 'Workflow 版本内部主键。'),
    column('workflow_id', 'bigint not null references agent_cluster.workflows(id)', '所属 Workflow 内部主键。'),
    column('version', 'integer not null check (version > 0)', 'Workflow 递增版本号。'),
    column('status', 'text not null', '版本状态。'),
    column('change_summary', 'text', '相对上一版本的变更摘要。'),
    column('definition_hash', 'text not null', '节点和边规范化定义的 SHA-256。'),
    column('definition_snapshot', "jsonb not null default '{}'::jsonb", '运行恢复所需且不包含文件正文的完整定义快照。'),
    column('created_at', 'timestamptz not null default now()', '版本创建时间。'),
    column('published_at', 'timestamptz', '版本发布时间。'),
    column('created_by', 'text', '创建该版本的操作者标识。')
  ], ['unique (workflow_id, version)']),
  table('workflow_nodes', '保存工作流版本中的 Agent、Tool、审批、条件或子工作流节点。', [
    column('id', 'bigint generated always as identity primary key', 'Workflow 节点内部主键。'),
    column('workflow_version_id', 'bigint not null references agent_cluster.workflow_versions(id) on delete cascade', '所属 Workflow 版本内部主键。'),
    column('node_key', 'text not null', '节点在该 Workflow 版本内的稳定键。'),
    column('name', 'text not null', '节点展示名称。'),
    column('node_type', 'text not null', '节点类型。'),
    column('agent_version_id', 'bigint references agent_cluster.agent_versions(id)', 'Agent 节点冻结的 Agent 版本内部主键。'),
    column('tool_version_id', 'bigint references agent_cluster.tool_versions(id)', 'Tool 节点冻结的 Tool 版本内部主键。'),
    column('sub_workflow_version_id', 'bigint references agent_cluster.workflow_versions(id)', '子工作流节点冻结的 Workflow 版本内部主键。'),
    column('position', 'integer not null default 0', '节点默认展示和顺序执行位置。'),
    column('execution_config', "jsonb not null default '{}'::jsonb", '节点执行、输入输出、审批和 UI 配置。'),
    column('timeout_ms', 'integer', '节点级超时时间，空值表示使用上层策略。'),
    column('created_at', 'timestamptz not null default now()', '节点创建时间。')
  ], ['unique (workflow_version_id, node_key)']),
  table('workflow_edges', '保存工作流版本中节点之间的条件流转关系。', [
    column('id', 'bigint generated always as identity primary key', 'Workflow 边内部主键。'),
    column('workflow_version_id', 'bigint not null references agent_cluster.workflow_versions(id) on delete cascade', '所属 Workflow 版本内部主键。'),
    column('edge_key', 'text not null', '边在该 Workflow 版本内的稳定键。'),
    column('from_node_id', 'bigint not null references agent_cluster.workflow_nodes(id) on delete cascade', '流转起点节点内部主键。'),
    column('to_node_id', 'bigint not null references agent_cluster.workflow_nodes(id) on delete cascade', '流转终点节点内部主键。'),
    column('transition_type', "text not null default 'success'", '触发流转的结果类型。'),
    column('condition_expression', 'text', '可选的确定性条件表达式。'),
    column('priority', 'integer not null default 0', '多条可用边的判定优先级。'),
    column('created_at', 'timestamptz not null default now()', '边创建时间。')
  ], ['unique (workflow_version_id, edge_key)']),
  table('sessions', '保存会话身份、状态、上下文管线、恢复版本和软删除信息。', [
    column('id', 'bigint generated always as identity primary key', 'Session 内部主键。'),
    column('external_id', 'text not null unique', '兼容现有合同的 Session 外部标识。'),
    column('title', 'text not null', '会话标题。'),
    column('status', 'text not null', '会话当前状态。'),
    column('owner_id', 'text not null', '会话所有者标识。'),
    column('project_id', 'text', '会话关联项目标识。'),
    column('context_pipeline_version', "text not null default 'v2'", '会话使用的上下文管线版本。'),
    column('data_epoch', 'text not null', '会话所属数据纪元。'),
    column('revision', 'bigint not null default 1', '会话并发更新 CAS 修订号。'),
    column('working_directory', 'text', '会话工作目录引用，不包含文件正文。'),
    column('metadata', "jsonb not null default '{}'::jsonb", '不包含文件正文的会话扩展元数据。'),
    column('created_at', 'timestamptz not null', '会话创建时间。'),
    column('updated_at', 'timestamptz not null', '会话最后更新时间。'),
    column('deleted_at', 'timestamptz', '会话软删除时间。')
  ], [], ['create index if not exists sessions_owner_updated_idx on agent_cluster.sessions (owner_id, updated_at desc) where deleted_at is null']),
  table('session_participants', '保存会话参与的用户或冻结 Agent 版本。', [
    column('id', 'bigint generated always as identity primary key', '会话参与者内部主键。'),
    column('session_id', 'bigint not null references agent_cluster.sessions(id) on delete cascade', '所属 Session 内部主键。'),
    column('actor_type', 'text not null', '参与者类型，例如 user、agent 或 system。'),
    column('actor_external_id', 'text not null', '参与者外部标识。'),
    column('display_name_snapshot', 'text not null', '加入会话时的参与者展示名称快照。'),
    column('agent_version_id', 'bigint references agent_cluster.agent_versions(id)', 'Agent 参与者冻结的版本内部主键。'),
    column('role', 'text', '参与者在会话中的角色。'),
    column('joined_at', 'timestamptz not null default now()', '参与者加入时间。'),
    column('left_at', 'timestamptz', '参与者离开时间。')
  ], ['unique (session_id, actor_type, actor_external_id)']),
  table('session_status_history', '按时间保存会话状态转换及其原因。', [
    column('id', 'bigint generated always as identity primary key', '状态历史内部主键。'),
    column('session_id', 'bigint not null references agent_cluster.sessions(id) on delete cascade', '所属 Session 内部主键。'),
    column('from_status', 'text', '状态转换前的状态。'),
    column('to_status', 'text not null', '状态转换后的状态。'),
    column('reason', 'text', '状态转换原因。'),
    column('actor_type', 'text', '触发状态转换的参与者类型。'),
    column('actor_external_id', 'text', '触发状态转换的参与者外部标识。'),
    column('created_at', 'timestamptz not null default now()', '状态转换时间。')
  ], [], ['create index if not exists session_status_history_session_idx on agent_cluster.session_status_history (session_id, created_at)']),
  table('session_progress', '保存会话当前阶段、完成比例和阻塞信息。', [
    column('session_id', 'bigint primary key references agent_cluster.sessions(id) on delete cascade', '所属 Session 内部主键。'),
    column('phase', 'text not null', '会话当前工作阶段。'),
    column('progress_percent', 'integer not null default 0 check (progress_percent between 0 and 100)', '当前完成百分比。'),
    column('current_task_external_id', 'text', '当前执行 Task 的外部标识。'),
    column('blocked_reason', 'text', '会话阻塞原因。'),
    column('details', "jsonb not null default '{}'::jsonb", '不包含文件正文的阶段扩展状态。'),
    column('updated_at', 'timestamptz not null default now()', '进度最后更新时间。')
  ]),
  table('collaboration_events', '保存完整会话消息和协作事件，是聊天时间线的事实记录。', [
    column('id', 'bigint generated always as identity primary key', '事件内部主键。'),
    column('external_id', 'text not null unique', '兼容现有合同的事件外部标识。'),
    column('session_id', 'bigint not null references agent_cluster.sessions(id) on delete cascade', '所属 Session 内部主键。'),
    column('session_seq', 'bigint not null', '事件在会话内严格递增的稳定序号。'),
    column('event_type', 'text not null', '协作事件类型。'),
    column('actor_type', 'text not null', '事件发送者类型。'),
    column('actor_external_id', 'text', '事件发送者外部标识。'),
    column('actor_display_name', 'text', '事件发生时的发送者名称快照。'),
    column('content', 'text', '聊天时间线可见的完整文本内容。'),
    column('payload', "jsonb not null default '{}'::jsonb", '不包含文件正文和密钥的结构化事件载荷。'),
    column('correlation_id', 'text', '关联同一业务操作的追踪标识。'),
    column('causation_id', 'text', '直接导致本事件的上游事件外部标识。'),
    column('created_at', 'timestamptz not null', '事件发生时间。')
  ], ['unique (session_id, session_seq)'], ['create index if not exists collaboration_events_replay_idx on agent_cluster.collaboration_events (session_id, session_seq)']),
  table('briefs', '保存会话中形成并由用户确认的任务简报。', [
    column('id', 'bigint generated always as identity primary key', 'Brief 内部主键。'),
    column('external_id', 'text not null unique', '兼容现有合同的 Brief 外部标识。'),
    column('session_id', 'bigint not null references agent_cluster.sessions(id) on delete cascade', '所属 Session 内部主键。'),
    column('title', 'text not null', 'Brief 标题。'),
    column('goal', 'text not null', 'Brief 目标。'),
    column('scope', "jsonb not null default '[]'::jsonb", 'Brief 范围条目。'),
    column('constraints', "jsonb not null default '[]'::jsonb", 'Brief 约束条目。'),
    column('acceptance_criteria', "jsonb not null default '[]'::jsonb", 'Brief 验收标准条目。'),
    column('source_snapshot', "jsonb not null default '{}'::jsonb", '文件正文已外置后的 Brief 单实体兼容快照。'),
    column('confirmed_by_user', 'boolean not null default false', 'Brief 是否已经用户确认。'),
    column('confirmed_at', 'timestamptz', 'Brief 用户确认时间。'),
    column('created_at', 'timestamptz not null', 'Brief 创建时间。'),
    column('updated_at', 'timestamptz not null', 'Brief 最后更新时间。')
  ], [], ['create index if not exists briefs_session_idx on agent_cluster.briefs (session_id, created_at)']),
  table('suggested_tasks', '保存 Brief 拆分阶段生成、尚未成为正式任务的建议任务。', [
    column('id', 'bigint generated always as identity primary key', '建议任务内部主键。'),
    column('external_id', 'text not null unique', '建议任务外部标识。'),
    column('brief_id', 'bigint references agent_cluster.briefs(id) on delete cascade', '所属 Brief 内部主键；历史孤立建议任务允许为空。'),
    column('legacy_brief_external_id', 'text', '无法关联活动 Brief 时保留的历史 Brief 外部标识。'),
    column('title', 'text not null', '建议任务标题。'),
    column('description', 'text', '建议任务说明。'),
    column('suggested_agent_external_id', 'text', '建议负责 Agent 外部标识。'),
    column('priority', 'integer not null default 0', '建议任务优先级。'),
    column('dependencies', "jsonb not null default '[]'::jsonb", '建议依赖任务外部标识列表。'),
    column('source_snapshot', "jsonb not null default '{}'::jsonb", '文件正文已外置后的建议任务单实体兼容快照。'),
    column('created_at', 'timestamptz not null default now()', '建议任务创建时间。')
  ]),
  table('tasks', '保存会话正式任务、依赖、负责人、状态和验证信息。', [
    column('id', 'bigint generated always as identity primary key', 'Task 内部主键。'),
    column('external_id', 'text not null unique', '兼容现有合同的 Task 外部标识。'),
    column('session_id', 'bigint not null references agent_cluster.sessions(id) on delete cascade', '所属 Session 内部主键。'),
    column('brief_id', 'bigint references agent_cluster.briefs(id)', '产生本 Task 的 Brief 内部主键。'),
    column('title', 'text not null', 'Task 标题。'),
    column('description', 'text', 'Task 说明。'),
    column('status', 'text not null', 'Task 当前状态。'),
    column('assignee_type', 'text', '负责人类型。'),
    column('assignee_external_id', 'text', '负责人外部标识。'),
    column('agent_version_id', 'bigint references agent_cluster.agent_versions(id)', '执行 Task 时冻结的 Agent 版本内部主键。'),
    column('priority', 'integer not null default 0', 'Task 调度优先级。'),
    column('dependencies', "jsonb not null default '[]'::jsonb", '依赖 Task 外部标识列表。'),
    column('acceptance_criteria', "jsonb not null default '[]'::jsonb", 'Task 验收标准。'),
    column('result_summary', 'text', 'Task 最新执行结果摘要。'),
    column('source_snapshot', "jsonb not null default '{}'::jsonb", '文件正文已外置后的 Task 单实体兼容快照。'),
    column('revision', 'bigint not null default 1', 'Task 并发更新 CAS 修订号。'),
    column('created_at', 'timestamptz not null', 'Task 创建时间。'),
    column('updated_at', 'timestamptz not null', 'Task 最后更新时间。'),
    column('completed_at', 'timestamptz', 'Task 完成时间。'),
    column('deleted_at', 'timestamptz', 'Task 软删除时间。')
  ], [], ['create index if not exists tasks_session_status_idx on agent_cluster.tasks (session_id, status) where deleted_at is null']),
  table('supplemental_context_requests', '保存 Runtime 对额外上下文的请求、重试和解决状态。', [
    column('id', 'bigint generated always as identity primary key', '补充上下文请求内部主键。'),
    column('external_id', 'text not null unique', '补充上下文请求外部标识。'),
    column('session_id', 'bigint not null references agent_cluster.sessions(id) on delete cascade', '所属 Session 内部主键。'),
    column('task_id', 'bigint references agent_cluster.tasks(id)', '关联 Task 内部主键。'),
    column('runtime_invocation_external_id', 'text', '提出请求的 RuntimeInvocation 外部标识。'),
    column('request_type', 'text not null', '所需上下文类型。'),
    column('request_payload', "jsonb not null default '{}'::jsonb", '经过脱敏且不含文件正文的请求参数。'),
    column('status', 'text not null', '请求当前处理状态。'),
    column('attempt_count', 'integer not null default 0', '已执行补充上下文重试次数。'),
    column('resolved_at', 'timestamptz', '请求成功解决时间。'),
    column('created_at', 'timestamptz not null default now()', '请求创建时间。'),
    column('updated_at', 'timestamptz not null default now()', '请求最后更新时间。')
  ]),
  table('memories', '保存会话短期记忆、会话记忆和待确认长期记忆。', [
    column('id', 'bigint generated always as identity primary key', 'Memory 内部主键。'),
    column('external_id', 'text not null unique', '兼容现有合同的 Memory 外部标识。'),
    column('session_id', 'bigint references agent_cluster.sessions(id) on delete cascade', '来源 Session 内部主键。'),
    column('scope', 'text not null', 'Memory 作用范围。'),
    column('content', 'text not null', 'Memory 语义正文。'),
    column('status', 'text not null', 'Memory 当前状态。'),
    column('source_event_external_id', 'text', '产生本 Memory 的事件外部标识。'),
    column('confirmed_by', 'text', '确认长期记忆的用户标识。'),
    column('confirmed_at', 'timestamptz', '长期记忆确认时间。'),
    column('metadata', "jsonb not null default '{}'::jsonb", '不包含文件正文的 Memory 扩展元数据。'),
    column('created_at', 'timestamptz not null', 'Memory 创建时间。'),
    column('updated_at', 'timestamptz not null', 'Memory 最后更新时间。'),
    column('deleted_at', 'timestamptz', 'Memory 软删除时间。')
  ], [], ['create index if not exists memories_session_idx on agent_cluster.memories (session_id, created_at)']),
  table('knowledge_documents', '保存知识库文档元数据以及正文的本地内容引用。', [
    column('id', 'bigint generated always as identity primary key', '知识文档内部主键。'),
    column('external_id', 'text not null unique', '兼容现有合同的知识文档外部标识。'),
    column('knowledge_base_id', 'bigint not null references agent_cluster.knowledge_bases(id) on delete cascade', '所属知识库内部主键。'),
    column('title', 'text not null', '知识文档标题。'),
    column('source_type', 'text not null', '知识文档来源类型。'),
    column('source_uri', 'text', '知识文档来源地址或路径。'),
    column('content_object_id', 'bigint references agent_cluster.content_objects(id)', '知识文档完整正文的内容对象内部主键。'),
    column('status', 'text not null', '知识文档处理状态。'),
    column('source_snapshot', "jsonb not null default '{}'::jsonb", '知识文档未被核心关系字段覆盖的单实体兼容快照。'),
    column('created_at', 'timestamptz not null', '知识文档创建时间。'),
    column('updated_at', 'timestamptz not null', '知识文档最后更新时间。'),
    column('deleted_at', 'timestamptz', '知识文档软删除时间。')
  ]),
  table('knowledge_chunks', '保存用于检索的知识文档分块和索引文本。', [
    column('id', 'bigint generated always as identity primary key', '知识分块内部主键。'),
    column('external_id', 'text not null unique', '兼容现有合同的知识分块外部标识。'),
    column('knowledge_document_id', 'bigint not null references agent_cluster.knowledge_documents(id) on delete cascade', '所属知识文档内部主键。'),
    column('position', 'integer not null', '分块在文档中的顺序位置。'),
    column('snippet', 'text not null', '用于检索和展示的分块正文。'),
    column('normalized_text', 'text not null', '用于当前本地检索的规范化文本。'),
    column('embedding_ref', 'text', '外部向量索引中的嵌入引用。'),
    column('metadata', "jsonb not null default '{}'::jsonb", '不包含文件正文的分块来源元数据。'),
    column('source_snapshot', "jsonb not null default '{}'::jsonb", '知识分块未被核心关系字段覆盖的单实体兼容快照。'),
    column('created_at', 'timestamptz not null default now()', '知识分块创建时间。')
  ], ['unique (knowledge_document_id, position)']),
  table('runtime_model_configs', '保存可维护的 Runtime 模型配置和加密密钥引用。', [
    column('id', 'bigint generated always as identity primary key', 'Runtime 模型配置内部主键。'),
    column('external_id', 'text not null unique', '模型配置对外稳定标识。'),
    column('name', 'text not null', '模型配置展示名称。'),
    column('provider', 'text not null', '模型提供方。'),
    column('model', 'text not null', '模型标识。'),
    column('model_kind', 'text not null', '模型类型，例如 local 或 remote。'),
    column('base_url', 'text', 'OpenAI 兼容服务基础地址。'),
    column('secret_ref', 'text', '加密密钥或外部密钥的引用。'),
    column('configuration', "jsonb not null default '{}'::jsonb", '不包含明文密钥的模型参数。'),
    column('status', "text not null default 'enabled'", '模型配置状态。'),
    column('created_at', 'timestamptz not null default now()', '模型配置创建时间。'),
    column('updated_at', 'timestamptz not null default now()', '模型配置最后更新时间。'),
    column('deleted_at', 'timestamptz', '模型配置软删除时间。')
  ]),
  table('runtime_invocations', '保存一次 Agent Runtime 执行的冻结输入、状态、结果和系统证据。', [
    column('id', 'bigint generated always as identity primary key', 'RuntimeInvocation 内部主键。'),
    column('external_id', 'text not null unique', '兼容现有合同的 RuntimeInvocation 外部标识。'),
    column('session_id', 'bigint references agent_cluster.sessions(id) on delete set null', '所属 Session 内部主键；孤立历史调用允许为空。'),
    column('legacy_session_external_id', 'text', '无法关联活动 Session 时保留的历史会话外部标识。'),
    column('task_id', 'bigint references agent_cluster.tasks(id) on delete set null', '关联 Task 内部主键。'),
    column('agent_version_id', 'bigint references agent_cluster.agent_versions(id)', '执行时冻结的 Agent 版本内部主键。'),
    column('runtime_type', 'text not null', '实际使用的 Runtime 类型。'),
    column('runtime_model_config_id', 'bigint references agent_cluster.runtime_model_configs(id)', '实际使用的模型配置内部主键。'),
    column('status', 'text not null', 'RuntimeInvocation 当前状态。'),
    column('context_envelope', "jsonb not null default '{}'::jsonb", '文件正文已外置后的 ContextEnvelope L0-L6。'),
    column('profile_snapshot', "jsonb not null default '{}'::jsonb", '执行时 Agent、Skill、Tool 和权限冻结快照。'),
    column('result_summary', 'text', '执行结果摘要。'),
    column('system_evidence', "jsonb not null default '{}'::jsonb", '文件正文已外置后的系统证据。'),
    column('usage', "jsonb not null default '{}'::jsonb", 'Token、费用和耗时统计。'),
    column('error_code', 'text', '失败时的稳定错误代码。'),
    column('error_message', 'text', '脱敏后的失败说明。'),
    column('started_at', 'timestamptz not null', 'RuntimeInvocation 开始时间。'),
    column('completed_at', 'timestamptz', 'RuntimeInvocation 结束时间。'),
    column('updated_at', 'timestamptz not null', 'RuntimeInvocation 最后更新时间。')
  ], [], ['create index if not exists runtime_invocations_session_idx on agent_cluster.runtime_invocations (session_id, started_at)']),
  table('tool_invocations', '在真实 Tool Executor 或 MCP Adapter 边界记录每一次工具调用。', [
    column('id', 'bigint generated always as identity primary key', 'ToolInvocation 内部主键。'),
    column('external_id', 'text not null unique', 'ToolInvocation 对外稳定标识。'),
    column('runtime_invocation_id', 'bigint references agent_cluster.runtime_invocations(id) on delete set null', '所属 RuntimeInvocation 内部主键。'),
    column('session_id', 'bigint references agent_cluster.sessions(id) on delete set null', '所属 Session 内部主键。'),
    column('legacy_session_external_id', 'text', '无法关联活动 Session 时保留的历史会话外部标识。'),
    column('tool_version_id', 'bigint references agent_cluster.tool_versions(id)', '已登记 Tool 的冻结版本内部主键。'),
    column('unknown_tool_name', 'text', '调用未登记工具时保留的提供方工具名称。'),
    column('mcp_server_id', 'bigint references agent_cluster.mcp_servers(id)', 'MCP 工具调用所属 Server 内部主键。'),
    column('provider_call_id', 'text', 'Runtime 或提供方返回的调用标识。'),
    column('status', 'text not null', '工具调用状态。'),
    column('arguments_redacted', "jsonb not null default '{}'::jsonb", '递归脱敏且文件正文已外置的工具参数。'),
    column('result_redacted', 'jsonb', '递归脱敏且大内容已外置的工具结果。'),
    column('result_content_object_id', 'bigint references agent_cluster.content_objects(id)', '大型原始结果的内容对象内部主键。'),
    column('error_code', 'text', '失败时的稳定错误代码。'),
    column('error_message', 'text', '递归脱敏后的错误说明。'),
    column('started_at', 'timestamptz not null', '工具调用开始时间。'),
    column('completed_at', 'timestamptz', '工具调用结束时间。'),
    column('duration_ms', 'bigint', '工具调用耗时毫秒数。')
  ], ['unique (runtime_invocation_id, provider_call_id)'], ['create index if not exists tool_invocations_session_idx on agent_cluster.tool_invocations (session_id, started_at)']),
  table('tool_invocation_authority_snapshots', '保存工具调用决策时的权限、Capability 和用户审批快照。', [
    column('tool_invocation_id', 'bigint primary key references agent_cluster.tool_invocations(id) on delete cascade', '所属 ToolInvocation 内部主键。'),
    column('agent_external_id', 'text', '权限判断中的 Agent 外部标识。'),
    column('capability_external_ids', "jsonb not null default '[]'::jsonb", '参与权限判断的 Capability 外部标识列表。'),
    column('risk_level', 'text', '调用时评估出的风险等级。'),
    column('approval_required', 'boolean not null default false', '调用时是否要求用户审批。'),
    column('approval_external_id', 'text', '关联审批记录外部标识。'),
    column('decision', 'text not null', '权限判断结果。'),
    column('reason', 'text', '权限判断原因。'),
    column('snapshot', "jsonb not null default '{}'::jsonb", '不包含密钥的完整权限判断快照。'),
    column('created_at', 'timestamptz not null default now()', '权限快照创建时间。')
  ]),
  table('capability_approvals', '保存用户对高风险 Capability 或 Tool 调用授予的审批。', [
    column('id', 'bigint generated always as identity primary key', 'Capability 审批内部主键。'),
    column('external_id', 'text not null unique', 'Capability 审批对外稳定标识。'),
    column('capability_id', 'bigint not null references agent_cluster.capabilities(id)', '获批 Capability 内部主键。'),
    column('session_id', 'bigint references agent_cluster.sessions(id) on delete set null', '审批限定的 Session 内部主键。'),
    column('agent_external_id', 'text', '审批限定的 Agent 外部标识。'),
    column('decision', 'text not null', '审批决定。'),
    column('reason', 'text', '审批原因或用户备注。'),
    column('approved_by', 'text not null', '审批用户标识。'),
    column('created_at', 'timestamptz not null default now()', '审批创建时间。'),
    column('expires_at', 'timestamptz', '审批失效时间。'),
    column('revoked_at', 'timestamptz', '审批撤销时间。')
  ]),
  table('artifacts', '保存会话交付物、报告和代码变更提案的元数据与正文引用。', [
    column('id', 'bigint generated always as identity primary key', 'Artifact 内部主键。'),
    column('external_id', 'text not null unique', '兼容现有合同的 Artifact 外部标识。'),
    column('session_id', 'bigint references agent_cluster.sessions(id) on delete set null', '所属 Session 内部主键。'),
    column('legacy_session_external_id', 'text', '无法关联活动 Session 时保留的历史会话外部标识。'),
    column('task_id', 'bigint references agent_cluster.tasks(id) on delete set null', '关联 Task 内部主键。'),
    column('runtime_invocation_id', 'bigint references agent_cluster.runtime_invocations(id) on delete set null', '产生本 Artifact 的 RuntimeInvocation 内部主键。'),
    column('artifact_type', 'text not null', 'Artifact 合同类型。'),
    column('title', 'text not null', 'Artifact 标题。'),
    column('summary', 'text', 'Artifact 可在会话时间线展示的摘要。'),
    column('content_object_id', 'bigint references agent_cluster.content_objects(id)', 'Artifact 大型正文的内容对象内部主键。'),
    column('metadata', "jsonb not null default '{}'::jsonb", '文件正文已外置后的 Artifact 元数据。'),
    column('status', "text not null default 'active'", 'Artifact 生命周期状态。'),
    column('created_at', 'timestamptz not null', 'Artifact 创建时间。'),
    column('updated_at', 'timestamptz not null', 'Artifact 最后更新时间。'),
    column('deleted_at', 'timestamptz', 'Artifact 软删除时间。')
  ], [], ['create index if not exists artifacts_session_idx on agent_cluster.artifacts (session_id, created_at)']),
  table('artifact_file_changes', '保存 Artifact 中每个文件变更的操作、哈希和本地内容引用。', [
    column('id', 'bigint generated always as identity primary key', '文件变更内部主键。'),
    column('artifact_id', 'bigint not null references agent_cluster.artifacts(id) on delete cascade', '所属 Artifact 内部主键。'),
    column('position', 'integer not null', '文件变更在 Artifact 中的稳定顺序。'),
    column('operation', 'text not null', '文件操作类型，例如 create、update、delete 或 move。'),
    column('path', 'text not null', '相对工作区根目录的目标路径。'),
    column('previous_path', 'text', 'move 操作的原始相对路径。'),
    column('before_sha256', 'text', '变更前内容 SHA-256。'),
    column('after_sha256', 'text', '变更后内容 SHA-256。'),
    column('content_object_id', 'bigint references agent_cluster.content_objects(id)', '新增或修改后正文的内容对象内部主键。'),
    column('applied_status', "text not null default 'proposed'", '文件变更是否已应用到 Workspace。'),
    column('applied_at', 'timestamptz', '文件变更成功应用时间。'),
    column('created_at', 'timestamptz not null default now()', '文件变更创建时间。')
  ], ['unique (artifact_id, position)']),
  table('workflow_runs', '保存会话执行某个不可变 Workflow 版本的运行实例。', [
    column('id', 'bigint generated always as identity primary key', 'WorkflowRun 内部主键。'),
    column('external_id', 'text not null unique', '兼容现有合同的 WorkflowRun 外部标识。'),
    column('session_id', 'bigint references agent_cluster.sessions(id) on delete set null', '所属 Session 内部主键；历史孤立运行允许为空。'),
    column('legacy_session_external_id', 'text', '无法关联活动 Session 时保留的历史会话外部标识。'),
    column('workflow_version_id', 'bigint not null references agent_cluster.workflow_versions(id)', '执行时冻结的 Workflow 版本内部主键。'),
    column('status', 'text not null', 'WorkflowRun 当前状态。'),
    column('current_node_key', 'text', '当前节点业务键。'),
    column('definition_snapshot', "jsonb not null default '{}'::jsonb", '启动运行时冻结的 Workflow 定义快照。'),
    column('revision', 'bigint not null default 1', 'WorkflowRun 并发更新 CAS 修订号。'),
    column('started_at', 'timestamptz not null', 'WorkflowRun 开始时间。'),
    column('completed_at', 'timestamptz', 'WorkflowRun 结束时间。'),
    column('updated_at', 'timestamptz not null', 'WorkflowRun 最后更新时间。')
  ], [], ['create index if not exists workflow_runs_session_idx on agent_cluster.workflow_runs (session_id, started_at)']),
  table('workflow_node_runs', '保存 WorkflowRun 中每个节点每次尝试的状态、输入和结果。', [
    column('id', 'bigint generated always as identity primary key', 'WorkflowNodeRun 内部主键。'),
    column('external_id', 'text not null unique', 'WorkflowNodeRun 对外稳定标识。'),
    column('workflow_run_id', 'bigint not null references agent_cluster.workflow_runs(id) on delete cascade', '所属 WorkflowRun 内部主键。'),
    column('workflow_node_id', 'bigint not null references agent_cluster.workflow_nodes(id)', '执行的 Workflow 节点内部主键。'),
    column('attempt', 'integer not null default 1', '该节点的执行尝试序号。'),
    column('status', 'text not null', '节点运行状态。'),
    column('runtime_invocation_id', 'bigint references agent_cluster.runtime_invocations(id) on delete set null', 'Agent 或 Tool 节点关联的 RuntimeInvocation 内部主键。'),
    column('input_snapshot', "jsonb not null default '{}'::jsonb", '文件正文已外置后的节点输入快照。'),
    column('result_snapshot', "jsonb not null default '{}'::jsonb", '文件正文已外置后的节点结果快照。'),
    column('error_code', 'text', '节点失败时的稳定错误代码。'),
    column('error_message', 'text', '节点失败时的脱敏说明。'),
    column('started_at', 'timestamptz not null', '节点运行开始时间。'),
    column('completed_at', 'timestamptz', '节点运行结束时间。'),
    column('updated_at', 'timestamptz not null', '节点运行最后更新时间。')
  ], ['unique (workflow_run_id, workflow_node_id, attempt)']),
  table('workflow_approvals', '保存 Workflow 人工或自动审批节点的决定和审计快照。', [
    column('id', 'bigint generated always as identity primary key', 'Workflow 审批内部主键。'),
    column('external_id', 'text not null unique', 'Workflow 审批对外稳定标识。'),
    column('workflow_node_run_id', 'bigint not null references agent_cluster.workflow_node_runs(id) on delete cascade', '所属节点运行内部主键。'),
    column('approval_type', 'text not null', '审批类型，例如 human 或 robot。'),
    column('decision', 'text not null', '审批决定。'),
    column('decided_by_type', 'text not null', '做出决定的参与者类型。'),
    column('decided_by_external_id', 'text', '做出决定的参与者外部标识。'),
    column('reason', 'text', '审批原因或备注。'),
    column('evidence', "jsonb not null default '{}'::jsonb", '不包含文件正文的审批证据快照。'),
    column('created_at', 'timestamptz not null default now()', '审批记录创建时间。')
  ]),
  table('workflow_effects', '可靠执行 Workflow 节点产生的业务副作用，与事件发布分离。', [
    column('id', 'bigint generated always as identity primary key', 'WorkflowEffect 内部主键。'),
    column('external_id', 'text not null unique', 'WorkflowEffect 对外稳定标识。'),
    column('workflow_run_id', 'bigint not null references agent_cluster.workflow_runs(id) on delete cascade', '所属 WorkflowRun 内部主键。'),
    column('workflow_node_run_id', 'bigint references agent_cluster.workflow_node_runs(id) on delete cascade', '产生副作用的节点运行内部主键。'),
    column('effect_type', 'text not null', '副作用类型。'),
    column('idempotency_key', 'text not null unique', '防止副作用重复执行的幂等键。'),
    column('payload', "jsonb not null default '{}'::jsonb", '文件正文已外置且脱敏后的副作用载荷。'),
    column('status', "text not null default 'pending'", '副作用执行状态。'),
    column('attempt_count', 'integer not null default 0', '副作用执行尝试次数。'),
    column('available_at', 'timestamptz not null default now()', '副作用下一次允许执行的时间。'),
    column('lease_owner', 'text', '当前处理该副作用的 worker 标识。'),
    column('lease_expires_at', 'timestamptz', '当前处理租约失效时间。'),
    column('last_error', 'text', '最近一次失败的脱敏说明。'),
    column('created_at', 'timestamptz not null default now()', '副作用创建时间。'),
    column('completed_at', 'timestamptz', '副作用成功完成时间。')
  ], [], ['create index if not exists workflow_effects_dispatch_idx on agent_cluster.workflow_effects (status, available_at)']),
  table('autopilots', '保存系统可维护的自动运行计划定义。', [
    column('id', 'bigint generated always as identity primary key', 'Autopilot 内部主键。'),
    column('external_id', 'text not null unique', '兼容现有合同的 Autopilot 外部标识。'),
    column('name', 'text not null', 'Autopilot 名称。'),
    column('prompt', 'text not null', 'Autopilot 创建会话时使用的用户目标。'),
    column('workflow_version_id', 'bigint references agent_cluster.workflow_versions(id)', 'Autopilot 固定使用的 Workflow 版本内部主键。'),
    column('schedule', 'text', 'Autopilot 调度表达式。'),
    column('status', 'text not null', 'Autopilot 生命周期状态。'),
    column('configuration', "jsonb not null default '{}'::jsonb", '不包含密钥的 Autopilot 扩展配置。'),
    column('created_at', 'timestamptz not null', 'Autopilot 创建时间。'),
    column('updated_at', 'timestamptz not null', 'Autopilot 最后更新时间。'),
    column('deleted_at', 'timestamptz', 'Autopilot 软删除时间。')
  ]),
  table('autopilot_runs', '保存一次 Autopilot 触发所创建的会话和运行结果。', [
    column('id', 'bigint generated always as identity primary key', 'AutopilotRun 内部主键。'),
    column('external_id', 'text not null unique', '兼容现有合同的 AutopilotRun 外部标识。'),
    column('autopilot_id', 'bigint not null references agent_cluster.autopilots(id)', '所属 Autopilot 内部主键。'),
    column('session_id', 'bigint references agent_cluster.sessions(id) on delete set null', '本次运行创建或关联的 Session 内部主键。'),
    column('status', 'text not null', 'AutopilotRun 当前状态。'),
    column('trigger_type', 'text not null', '触发类型，例如 manual 或 schedule。'),
    column('result_summary', 'text', '运行结果摘要。'),
    column('source_snapshot', "jsonb not null default '{}'::jsonb", 'AutopilotRun 未被核心关系字段覆盖的单实体兼容快照。'),
    column('started_at', 'timestamptz not null', 'AutopilotRun 开始时间。'),
    column('completed_at', 'timestamptz', 'AutopilotRun 结束时间。')
  ]),
  table('event_outbox', '保存事务提交后需要可靠发布到 SSE 或其他消费者的事件。', [
    column('id', 'bigint generated always as identity primary key', 'Outbox 事件内部主键。'),
    column('external_id', 'text not null unique', 'Outbox 事件对外稳定标识。'),
    column('aggregate_type', 'text not null', '产生事件的聚合类型。'),
    column('aggregate_external_id', 'text not null', '产生事件的聚合外部标识。'),
    column('event_type', 'text not null', '待发布事件类型。'),
    column('payload', "jsonb not null default '{}'::jsonb", '文件正文已外置且脱敏后的事件载荷。'),
    column('idempotency_key', 'text not null unique', '消费者去重使用的幂等键。'),
    column('status', "text not null default 'pending'", 'Outbox 发布状态。'),
    column('attempt_count', 'integer not null default 0', '发布尝试次数。'),
    column('available_at', 'timestamptz not null default now()', '下一次允许发布的时间。'),
    column('lease_owner', 'text', '当前发布 worker 标识。'),
    column('lease_expires_at', 'timestamptz', '当前发布租约失效时间。'),
    column('last_error', 'text', '最近一次发布失败的脱敏说明。'),
    column('created_at', 'timestamptz not null default now()', 'Outbox 事件创建时间。'),
    column('published_at', 'timestamptz', 'Outbox 事件成功发布时间。')
  ], [], ['create index if not exists event_outbox_dispatch_idx on agent_cluster.event_outbox (status, available_at)']),
  table('cutover_audits', '保存数据切换申请、确认、执行结果和只读归档信息。', [
    column('id', 'bigint generated always as identity primary key', '切换审计内部主键。'),
    column('external_id', 'text not null unique', '兼容现有合同的切换审计外部标识。'),
    column('environment', 'text not null', '执行切换的环境。'),
    column('operator_id', 'text', '执行切换的操作者标识。'),
    column('source_epoch', 'text', '切换前数据纪元。'),
    column('target_epoch', 'text', '切换后数据纪元。'),
    column('source_revision', 'text', '切换前源状态修订哈希。'),
    column('status', 'text not null', '切换审计状态。'),
    column('result', 'text', '切换执行结果。'),
    column('summary', "jsonb not null default '{}'::jsonb", '切换集合数量、归档和校验摘要。'),
    column('archive_path', 'text', '旧数据只读加密归档路径。'),
    column('created_at', 'timestamptz not null default now()', '切换审计创建时间。'),
    column('completed_at', 'timestamptz', '切换审计完成时间。')
  ])
];

export const RELATIONAL_SCHEMA_V2_TABLES: RelationalTableDefinition[] = [
  table('local_runtime_devices', '保存本机 Runtime CLI 设备身份、兼容版本和轮换令牌摘要。', [
    column('id', 'bigint generated always as identity primary key', '本机 Runtime 设备内部主键。'),
    column('device_id', 'text not null unique', 'CLI 生成并长期保存的稳定设备标识。'),
    column('owner_id', 'text not null', '拥有该设备授权的用户标识。'),
    column('display_name', 'text not null', '设备在管理界面中的展示名称。'),
    column('status', 'text not null', '设备当前状态，例如 active 或 revoked。'),
    column('cli_version', 'text not null', '设备最近上报的 Runtime CLI 版本。'),
    column('protocol_version', 'integer not null', '设备最近上报的本机 Runtime 协议版本。'),
    column('runtimes', "jsonb not null default '{}'::jsonb", '设备可执行的 Runtime 类型及版本。'),
    column('access_token_hash', 'text', '当前短期访问令牌的单向摘要。'),
    column('access_token_expires_at', 'timestamptz', '当前短期访问令牌的过期时间。'),
    column('refresh_token_hash', 'text', '当前刷新令牌的单向摘要。'),
    column('refresh_token_expires_at', 'timestamptz', '当前刷新令牌的过期时间。'),
    column('created_at', 'timestamptz not null', '设备首次授权时间。'),
    column('last_seen_at', 'timestamptz', '设备最近一次通过鉴权或发送心跳的时间。'),
    column('revoked_at', 'timestamptz', '设备授权被撤销的时间。'),
    column('source_snapshot', "jsonb not null default '{}'::jsonb", '用于无损回读本机 Runtime 设备合同的兼容快照。'),
    column('updated_at', 'timestamptz not null default now()', '设备记录最近更新时间。')
  ], [], ['create index if not exists local_runtime_devices_owner_idx on agent_cluster.local_runtime_devices (owner_id, status)']),
  table('local_runtime_operation_audits', '保存平台通过本机 Runtime 工作区执行操作时的脱敏审计记录。', [
    column('id', 'bigint generated always as identity primary key', '本机 Runtime 操作审计内部主键。'),
    column('request_id', 'text not null unique', '工作区操作请求的稳定标识。'),
    column('invocation_id', 'text not null', '触发该操作的 Runtime 调用标识。'),
    column('owner_id', 'text not null', '操作发生时的设备所有者标识。'),
    column('workspace_id', 'text not null', '操作针对的授权工作区标识。'),
    column('operation', 'text not null', '工作区操作类型。'),
    column('revision_id', 'text not null', '操作绑定的工作区版本标识。'),
    column('status', 'text not null', '操作审计状态，例如 pending、ok 或 error。'),
    column('error_code', 'text', '操作失败时的稳定错误码。'),
    column('requested_at', 'timestamptz not null', '操作请求创建时间。'),
    column('completed_at', 'timestamptz', '操作完成时间。'),
    column('source_snapshot', "jsonb not null default '{}'::jsonb", '用于无损回读操作审计合同的兼容快照。')
  ], [], ['create index if not exists local_runtime_operation_audits_workspace_idx on agent_cluster.local_runtime_operation_audits (workspace_id, requested_at)'])
];

export const RELATIONAL_SCHEMA_V3_TABLES: RelationalTableDefinition[] = [
  table('file_revision_records', '保存不可变文件基线以及用户修订后的多 Agent 处理运行记录。', [
    column('id', 'bigint generated always as identity primary key', '文件修订记录内部主键。'),
    column('external_id', 'text not null unique', '基线或修订运行的稳定业务标识。'),
    column('session_id', 'bigint references agent_cluster.sessions(id) on delete cascade', '所属会话内部主键。'),
    column('legacy_session_external_id', 'text', '父会话记录暂不可用时保留的会话业务标识。'),
    column('record_type', 'text not null check (record_type in (\'baseline\', \'run\'))', '区分不可变基线记录与修订处理运行记录。'),
    column('status', 'text', '修订运行当前状态；基线记录为空。'),
    column('file_path', 'text not null', '工作区内相对源文件路径。'),
    column('source_snapshot', "jsonb not null default '{}'::jsonb", '仅保存内容引用的无损领域快照。'),
    column('created_at', 'timestamptz not null', '记录创建时间。'),
    column('updated_at', 'timestamptz not null', '记录最近更新时间。'),
    column('deleted_at', 'timestamptz', '记录软删除时间。')
  ], [], [
    'create index if not exists file_revision_records_session_idx on agent_cluster.file_revision_records (session_id, created_at)',
    'create index if not exists file_revision_records_active_idx on agent_cluster.file_revision_records (record_type, status) where deleted_at is null'
  ])
];

export const RELATIONAL_SCHEMA_V4_TABLES: RelationalTableDefinition[] = [
  table('workspace_session_leases', '保存单工作区单活动会话租约，防止同一工作区并发接入多个会话。', [
    column('workspace_id', 'text primary key', '被租约保护的工作区标识。'),
    column('session_id', 'text not null', '持有租约的会话标识。'),
    column('acquired_at', 'timestamptz not null', '租约获取时间。')
  ]),
  table('workspace_writebacks', '保存隔离执行结果的自动写回、冲突和用户解决状态，支持后端重启后恢复。', [
    column('external_id', 'text primary key', '写回记录的稳定外部标识。'),
    column('session_external_id', 'text not null', '写回所属会话的稳定外部标识。'),
    column('workspace_id', 'text not null', '写回目标工作区标识。'),
    column('status', 'text not null', '写回当前状态，例如 queued、conflicted、applied 或 abandoned。'),
    column('source_snapshot', "jsonb not null default '{}'::jsonb", '用于无损恢复完整 WorkspaceWritebackRecord 的快照。'),
    column('created_at', 'timestamptz not null', '写回记录创建时间。'),
    column('updated_at', 'timestamptz not null', '写回记录最后更新时间。')
  ], [], [
    'create index if not exists workspace_writebacks_session_idx on agent_cluster.workspace_writebacks (session_external_id, created_at)',
    'create index if not exists workspace_writebacks_workspace_status_idx on agent_cluster.workspace_writebacks (workspace_id, status, created_at)'
  ])
];

export const RELATIONAL_SCHEMA_V5_TABLES: RelationalTableDefinition[] = [
  table('system_agent_runtime_policies', '保存系统 Agent 与 Runtime/Model 解耦的独立路由策略。', [
    column('system_role', 'text primary key', '系统 Agent 的稳定角色标识。'),
    column('preferred_runtime_type', 'text', '优先选择的 Runtime 类型。'),
    column('preferred_model_id', 'text', '优先选择的模型配置标识。'),
    column('allowed_runtime_types', "jsonb not null default '[]'::jsonb", '允许参与路由的 Runtime 类型集合。'),
    column('source_snapshot', "jsonb not null default '{}'::jsonb", '用于无损恢复 RuntimePolicy 合同的兼容快照。'),
    column('updated_at', 'timestamptz not null default now()', '策略最后更新时间。')
  ]),
  table('work_items', '保存同一会话窗口中的独立或关联逻辑需求及其上下文边界。', [
    column('id', 'bigint generated always as identity primary key', 'WorkItem 内部主键。'),
    column('external_id', 'text not null unique', 'WorkItem 对外稳定标识。'),
    column('session_id', 'bigint not null references agent_cluster.sessions(id) on delete cascade', '所属 Session 内部主键。'),
    column('parent_work_item_id', 'bigint references agent_cluster.work_items(id)', '关联新需求继承的父 WorkItem。'),
    column('title', 'text not null', 'WorkItem 展示标题。'),
    column('goal', 'text not null', '当前逻辑需求的权威目标。'),
    column('status', 'text not null', 'WorkItem 独立状态机中的当前状态。'),
    column('revision', 'bigint not null default 1', 'WorkItem 乐观并发修订号。'),
    column('created_from_event_external_id', 'text not null', '创建本 WorkItem 的用户事件外部标识。'),
    column('source_snapshot', "jsonb not null default '{}'::jsonb", '用于无损恢复 WorkItem 合同的兼容快照。'),
    column('created_at', 'timestamptz not null', 'WorkItem 创建时间。'),
    column('updated_at', 'timestamptz not null', 'WorkItem 最后更新时间。'),
    column('deleted_at', 'timestamptz', 'WorkItem 进入不可见软删除状态的时间。')
  ], [], [
    'create index if not exists work_items_session_status_idx on agent_cluster.work_items (session_id, status, updated_at desc) where deleted_at is null'
  ]),
  table('decision_records', '保存用户确认、约束、偏好和纠正形成的可追溯决策账本。', [
    column('id', 'bigint generated always as identity primary key', 'DecisionRecord 内部主键。'),
    column('external_id', 'text not null unique', 'DecisionRecord 对外稳定标识。'),
    column('session_id', 'bigint not null references agent_cluster.sessions(id) on delete cascade', '所属 Session 内部主键。'),
    column('work_item_id', 'bigint not null references agent_cluster.work_items(id) on delete cascade', '所属 WorkItem 内部主键。'),
    column('decision_kind', 'text not null', '决策类别，例如 requirement、constraint 或 approval。'),
    column('status', 'text not null', '决策当前状态，例如 confirmed 或 superseded。'),
    column('content', 'text not null', '决策的规范化文本内容。'),
    column('source_event_external_id', 'text not null', '产生该决策的用户事件外部标识。'),
    column('supersedes_decision_id', 'bigint references agent_cluster.decision_records(id)', '被当前决策替代的旧决策。'),
    column('revision', 'bigint not null default 1', 'DecisionRecord 修订号。'),
    column('confirmation', "jsonb not null default '{}'::jsonb", '确认主体与确认来源的审计快照。'),
    column('source_snapshot', "jsonb not null default '{}'::jsonb", '用于无损恢复 DecisionRecord 合同的兼容快照。'),
    column('created_at', 'timestamptz not null', '决策首次记录时间。'),
    column('updated_at', 'timestamptz not null', '决策最后更新时间。')
  ], [], ['create index if not exists decision_records_work_item_idx on agent_cluster.decision_records (work_item_id, status, created_at)']),
  table('work_item_decision_inheritances', '记录关联新 WorkItem 显式继承的已确认决策。', [
    column('work_item_id', 'bigint not null references agent_cluster.work_items(id) on delete cascade', '继承决策的目标 WorkItem。'),
    column('decision_id', 'bigint not null references agent_cluster.decision_records(id) on delete cascade', '被继承的 DecisionRecord。'),
    column('source_work_item_id', 'bigint not null references agent_cluster.work_items(id)', '决策原始所属 WorkItem。'),
    column('created_at', 'timestamptz not null default now()', '继承关系创建时间。')
  ], ['primary key (work_item_id, decision_id)']),
  table('work_item_artifact_inheritances', '记录关联新 WorkItem 显式继承的交付物引用。', [
    column('work_item_id', 'bigint not null references agent_cluster.work_items(id) on delete cascade', '继承交付物的目标 WorkItem。'),
    column('artifact_id', 'bigint not null references agent_cluster.artifacts(id) on delete cascade', '被继承的 Artifact。'),
    column('source_work_item_id', 'bigint not null references agent_cluster.work_items(id)', '交付物原始所属 WorkItem。'),
    column('created_at', 'timestamptz not null default now()', '继承关系创建时间。')
  ], ['primary key (work_item_id, artifact_id)']),
  table('context_snapshots', '保存意图路由和 Runtime 上下文组装使用的不可变最小快照。', [
    column('id', 'bigint generated always as identity primary key', 'ContextSnapshot 内部主键。'),
    column('external_id', 'text not null unique', 'ContextSnapshot 对外稳定标识。'),
    column('session_id', 'bigint not null references agent_cluster.sessions(id) on delete cascade', '所属 Session 内部主键。'),
    column('work_item_id', 'bigint references agent_cluster.work_items(id) on delete set null', '快照关联的活动 WorkItem。'),
    column('source_event_external_id', 'text not null', '触发快照的用户事件外部标识。'),
    column('purpose', 'text not null', '快照用途，例如 intent_routing 或 runtime_context。'),
    column('revision_vector', "jsonb not null default '{}'::jsonb", '参与快照一致性校验的修订向量。'),
    column('snapshot_hash', 'text not null', '规范化快照内容的 SHA-256。'),
    column('payload', "jsonb not null default '{}'::jsonb", '不包含完整历史和工作区正文的最小快照载荷。'),
    column('created_at', 'timestamptz not null', '快照创建时间。')
  ], [], ['create index if not exists context_snapshots_session_idx on agent_cluster.context_snapshots (session_id, created_at desc)']),
  table('intent_routing_records', '保存每条用户消息从接收、分类、校验到应用的完整路由审计。', [
    column('id', 'bigint generated always as identity primary key', 'IntentRoutingRecord 内部主键。'),
    column('external_id', 'text not null unique', 'IntentRoutingRecord 对外稳定标识。'),
    column('session_id', 'bigint not null references agent_cluster.sessions(id) on delete cascade', '所属 Session 内部主键。'),
    column('source_event_external_id', 'text not null', '被路由的用户事件外部标识。'),
    column('session_seq', 'bigint not null', '消息在 Session 内的严格顺序号。'),
    column('status', 'text not null', '消息级路由状态。'),
    column('policy_version', 'text not null', '执行本次判断的路由策略版本。'),
    column('rollout_mode', 'text not null', '本次判断采用的发布模式。'),
    column('context_snapshot_id', 'bigint references agent_cluster.context_snapshots(id)', '分类时使用的不可变 ContextSnapshot。'),
    column('runtime_invocation_external_id', 'text', '意图 Agent Runtime 调用外部标识。'),
    column('decision_payload', "jsonb not null default '{}'::jsonb", '模型返回并经解析的结构化路由建议。'),
    column('validation_payload', "jsonb not null default '{}'::jsonb", '服务端 Schema、引用、状态与风险校验结果。'),
    column('final_action', 'text', '服务端最终应用的路由动作。'),
    column('lease_owner', 'text', '当前处理该路由记录的 worker 标识。'),
    column('lease_expires_at', 'timestamptz', '当前路由处理租约的失效时间。'),
    column('reason_codes', "jsonb not null default '[]'::jsonb", '稳定的裁决原因代码。'),
    column('retry_count', 'integer not null default 0', '分类或应用的有限重试次数。'),
    column('idempotency_key', 'text not null unique', '路由流程幂等键。'),
    column('source_snapshot', "jsonb not null default '{}'::jsonb", '用于无损恢复 IntentRoutingRecord 合同的兼容快照。'),
    column('created_at', 'timestamptz not null', '路由记录创建时间。'),
    column('updated_at', 'timestamptz not null', '路由记录最后更新时间。')
  ], ['unique (session_id, session_seq, policy_version)'], [
    'create index if not exists intent_routing_pending_idx on agent_cluster.intent_routing_records (status, updated_at)'
  ]),
  table('session_follow_up_messages', '保存路由完成后等待 Coordinator 规划或执行的用户补充消息。', [
    column('id', 'bigint generated always as identity primary key', 'FollowUpMessage 内部主键。'),
    column('external_id', 'text not null unique', 'FollowUpMessage 对外稳定标识。'),
    column('session_id', 'bigint not null references agent_cluster.sessions(id) on delete cascade', '所属 Session 内部主键。'),
    column('work_item_id', 'bigint references agent_cluster.work_items(id) on delete set null', '消息路由后归属的 WorkItem。'),
    column('routing_record_id', 'bigint references agent_cluster.intent_routing_records(id) on delete set null', '产生该 FollowUp 的路由记录。'),
    column('source_event_external_id', 'text not null', '原始用户事件外部标识。'),
    column('status', 'text not null', 'FollowUp 当前排队、规划或执行状态。'),
    column('handling_payload', "jsonb not null default '{}'::jsonb", '消息内容、提及对象和处理计划快照。'),
    column('queued_at', 'timestamptz not null', '进入处理队列的时间。'),
    column('started_at', 'timestamptz', '开始规划或执行的时间。'),
    column('completed_at', 'timestamptz', '处理完成的时间。')
  ], [], ['create index if not exists session_follow_up_messages_queue_idx on agent_cluster.session_follow_up_messages (session_id, status, queued_at)'])
];

const CURRENT_VERSION_FOREIGN_KEYS = [
  'alter table agent_cluster.agents add constraint agents_current_version_fk foreign key (current_version_id) references agent_cluster.agent_versions(id)',
  'alter table agent_cluster.skills add constraint skills_current_version_fk foreign key (current_version_id) references agent_cluster.skill_versions(id)',
  'alter table agent_cluster.tools add constraint tools_current_version_fk foreign key (current_version_id) references agent_cluster.tool_versions(id)',
  'alter table agent_cluster.workflows add constraint workflows_current_version_fk foreign key (current_version_id) references agent_cluster.workflow_versions(id)'
];

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return value;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function renderTables(definitions: RelationalTableDefinition[]): string {
  return definitions
    .flatMap((definition) => {
      const tableName = identifier(definition.name);
      const definitionsSql = [
        ...definition.columns.map((item) => `  ${identifier(item.name)} ${item.sql}`),
        ...(definition.constraints ?? []).map((item) => `  ${item}`)
      ].join(',\n');
      return [
        `create table if not exists ${RELATIONAL_SCHEMA_NAME}.${tableName} (\n${definitionsSql}\n)`,
        `comment on table ${RELATIONAL_SCHEMA_NAME}.${tableName} is ${literal(definition.comment)}`,
        ...definition.columns.map(
          (item) =>
            `comment on column ${RELATIONAL_SCHEMA_NAME}.${tableName}.${identifier(item.name)} is ${literal(item.comment)}`
        ),
        ...(definition.indexes ?? [])
      ];
    })
    .map((statement) => `${statement};`)
    .join('\n\n');
}

export const RELATIONAL_SCHEMA_BOOTSTRAP_SQL = [
  `create schema if not exists ${RELATIONAL_SCHEMA_NAME}`,
  `comment on schema ${RELATIONAL_SCHEMA_NAME} is ${literal('Agent Cluster 关系型业务数据、运行记录和审计数据。')}`,
  renderTables([SCHEMA_MIGRATIONS_TABLE])
]
  .map((statement) => (statement.endsWith(';') ? statement : `${statement};`))
  .join('\n\n');

export const RELATIONAL_SCHEMA_V1_SQL = [
  renderTables(RELATIONAL_TABLES),
  ...CURRENT_VERSION_FOREIGN_KEYS.map(
    (statement) =>
      `do $$ begin ${statement}; exception when duplicate_object then null; end $$;`
  )
].join('\n\n');

export const RELATIONAL_SCHEMA_V2_SQL = renderTables(RELATIONAL_SCHEMA_V2_TABLES);
export const RELATIONAL_SCHEMA_V3_SQL = renderTables(RELATIONAL_SCHEMA_V3_TABLES);
export const RELATIONAL_SCHEMA_V4_SQL = renderTables(RELATIONAL_SCHEMA_V4_TABLES);
export const RELATIONAL_SCHEMA_V5_SQL = [
  renderTables(RELATIONAL_SCHEMA_V5_TABLES),
  'alter table agent_cluster.sessions add column if not exists active_work_item_id bigint',
  "comment on column agent_cluster.sessions.active_work_item_id is '会话当前活动 WorkItem 内部主键。'",
  'do $$ begin alter table agent_cluster.sessions add constraint sessions_active_work_item_fk foreign key (active_work_item_id) references agent_cluster.work_items(id); exception when duplicate_object then null; end $$',
  ...['briefs', 'tasks', 'artifacts', 'runtime_invocations', 'workflow_runs'].flatMap((tableName) => [
    `alter table agent_cluster.${tableName} add column if not exists work_item_id bigint`,
    `comment on column agent_cluster.${tableName}.work_item_id is '该记录所属 WorkItem 内部主键。'`,
    `do $$ begin alter table agent_cluster.${tableName} add constraint ${tableName}_work_item_fk foreign key (work_item_id) references agent_cluster.work_items(id) on delete set null; exception when duplicate_object then null; end $$`
  ])
].map((statement) => statement.endsWith(';') ? statement : `${statement};`).join('\n\n');

export const RELATIONAL_SCHEMA_V6_SQL = [
  'alter table agent_cluster.memories add column if not exists work_item_id bigint',
  "comment on column agent_cluster.memories.work_item_id is 'Memory 所属 WorkItem 的内部主键。'",
  'do $$ begin alter table agent_cluster.memories add constraint memories_work_item_fk foreign key (work_item_id) references agent_cluster.work_items(id) on delete set null; exception when duplicate_object then null; end $$',
  'create index if not exists memories_work_item_idx on agent_cluster.memories (work_item_id, created_at desc)',
  'alter table agent_cluster.intent_routing_records add column if not exists action_status text',
  "comment on column agent_cluster.intent_routing_records.action_status is '路由最终动作的可恢复提交状态。'"
].map((statement) => statement.endsWith(';') ? statement : `${statement};`).join('\n\n');

export const RELATIONAL_SCHEMA_V7_SQL = [
  'alter table agent_cluster.intent_routing_records add column if not exists lease_owner text',
  "comment on column agent_cluster.intent_routing_records.lease_owner is '当前处理该路由记录的 worker 标识。'",
  'alter table agent_cluster.intent_routing_records add column if not exists lease_expires_at timestamptz',
  "comment on column agent_cluster.intent_routing_records.lease_expires_at is '当前路由处理租约的失效时间。'",
  'create index if not exists intent_routing_lease_idx on agent_cluster.intent_routing_records (status, lease_expires_at)'
].map((statement) => statement.endsWith(';') ? statement : `${statement};`).join('\n\n');

export const RELATIONAL_SCHEMA_V8_TABLES: RelationalTableDefinition[] = [
  table('logical_operations', '持久化调用额度与停止确认，进程启动前原子预留。', [
    column('external_id', 'text primary key', '逻辑操作标识。'),
    column('session_id', 'bigint not null references agent_cluster.sessions(id) on delete cascade', '所属会话。'),
    column('source_snapshot', 'jsonb not null', '版本化预算、调用记录及停止状态。')
  ], [], ['create index if not exists logical_operations_session_idx on agent_cluster.logical_operations(session_id)'])
];
export const RELATIONAL_SCHEMA_V8_SQL = renderTables(RELATIONAL_SCHEMA_V8_TABLES);

export const RELATIONAL_SCHEMA_V9_TABLES: RelationalTableDefinition[] = [
  table('session_stop_requests', '保存会话停止轮次的固定目标、单调版本和可信确认状态。', [
    column('external_id', 'text primary key', '停止请求的稳定外部标识。'),
    column('session_id', 'bigint not null references agent_cluster.sessions(id) on delete cascade', '停止请求所属会话。'),
    column('version', 'integer not null check (version > 0)', '停止聚合状态的单调版本。'),
    column('status', 'text not null', '停止请求的聚合状态。'),
    column('source_snapshot', 'jsonb not null', '固定目标、结束证据引用和兼容字段快照。'),
    column('created_at', 'timestamptz not null', '停止请求创建时间。'),
    column('updated_at', 'timestamptz not null', '停止状态最后更新时间。')
  ], [], [
    'create index if not exists session_stop_requests_session_idx on agent_cluster.session_stop_requests(session_id, created_at)',
    "create unique index if not exists session_stop_requests_one_open_idx on agent_cluster.session_stop_requests(session_id) where status <> 'confirmed'"
  ])
];
export const RELATIONAL_SCHEMA_V9_SQL = renderTables(RELATIONAL_SCHEMA_V9_TABLES);

export const RELATIONAL_SCHEMA_V10_TABLES: RelationalTableDefinition[] = [
  table('session_lifecycles', '保存会话执行准入、删除墓碑、恢复代次和停止聚合状态。', [
    column('session_id', 'bigint primary key references agent_cluster.sessions(id) on delete cascade', '生命周期所属会话。'),
    column('generation', 'integer not null check (generation > 0)', '删除或恢复边界递增的会话代次。'),
    column('revision', 'integer not null check (revision > 0)', '生命周期快照的单调修订号。'),
    column('state', 'text not null check (state in (\'active\',\'deleting\',\'deleted\'))', '会话可恢复生命周期状态。'),
    column('admission', 'text not null check (admission in (\'open\',\'closed\'))', '是否允许创建新的执行预留。'),
    column('stop_status', 'text not null', '目标会话最近一次停止聚合状态。'),
    column('source_snapshot', 'jsonb not null', '版本化生命周期合同完整快照。'),
    column('updated_at', 'timestamptz not null', '生命周期最后更新时间。')
  ], [], [
    'create index if not exists session_lifecycles_state_idx on agent_cluster.session_lifecycles(state, updated_at)'
  ])
];
export const RELATIONAL_SCHEMA_V10_SQL = renderTables(RELATIONAL_SCHEMA_V10_TABLES);

export const RELATIONAL_SCHEMA_V11_TABLES: RelationalTableDefinition[] = [
  table('work_item_budgets', '保存需求级累计模型预算总账：预留、实际、未知用量与尝试去重状态。', [
    column('work_item_external_id', 'text primary key', '预算总账所属需求的稳定外部标识。'),
    column('session_id', 'bigint not null references agent_cluster.sessions(id) on delete cascade', '总账所属会话。'),
    column('revision', 'integer not null check (revision > 0)', '总账快照的单调修订号。'),
    column('limit_tokens', 'bigint not null check (limit_tokens >= 0)', '该需求的累计输入预算上限。'),
    column('reserved_tokens', 'bigint not null check (reserved_tokens >= 0)', '尚未结算的预留额度合计。'),
    column('actual_tokens', 'bigint not null check (actual_tokens >= 0)', 'provider 上报的实际用量合计。'),
    column('unknown_tokens', 'bigint not null check (unknown_tokens >= 0)', '用量不可得时按预留上限保留的保守合计。'),
    column('source_snapshot', 'jsonb not null', '版本化预算总账合同完整快照。'),
    column('updated_at', 'timestamptz not null', '总账最后更新时间。')
  ], [], [
    'create index if not exists work_item_budgets_session_idx on agent_cluster.work_item_budgets(session_id, updated_at)'
  ])
];
export const RELATIONAL_SCHEMA_V11_SQL = renderTables(RELATIONAL_SCHEMA_V11_TABLES);

export const RELATIONAL_SCHEMA_V12_TABLES: RelationalTableDefinition[] = [
  table('summary_checkpoints', '保存需求级增量摘要检查点：覆盖范围、需求/决策版本、策略版本与来源引用；同一逻辑键只提交一次。', [
    column('external_id', 'text primary key', '检查点稳定外部标识。'),
    column('session_id', 'bigint not null references agent_cluster.sessions(id) on delete cascade', '检查点所属会话。'),
    column('work_item_external_id', 'text not null', '检查点所属需求的稳定外部标识。'),
    column('logical_key', 'text not null unique', '需求 + 覆盖范围 + 版本指纹组成的唯一逻辑键。'),
    column('covered_event_seq', 'bigint not null check (covered_event_seq >= 0)', '摘要已覆盖的会话事件序号上界。'),
    column('work_item_revision', 'bigint not null check (work_item_revision > 0)', '生成时绑定的需求修订号。'),
    column('decision_ledger_revision', 'bigint not null check (decision_ledger_revision >= 0)', '生成时绑定的决策账本修订号。'),
    column('policy_version', 'text not null', '摘要生成策略版本。'),
    column('content_hash', 'text not null', '摘要正文的稳定哈希。'),
    column('generation', 'integer', '生成时绑定的会话生命周期代次；空表示旧会话。'),
    column('source_snapshot', 'jsonb not null', '版本化检查点合同完整快照。'),
    column('created_at', 'timestamptz not null', '检查点提交时间。')
  ], [], [
    'create index if not exists summary_checkpoints_work_item_idx on agent_cluster.summary_checkpoints(session_id, work_item_external_id, covered_event_seq desc)'
  ])
];
export const RELATIONAL_SCHEMA_V12_SQL = renderTables(RELATIONAL_SCHEMA_V12_TABLES);

export function expectedRelationalComments() {
  return [
    SCHEMA_MIGRATIONS_TABLE,
    ...RELATIONAL_TABLES,
    ...RELATIONAL_SCHEMA_V2_TABLES,
    ...RELATIONAL_SCHEMA_V3_TABLES,
    ...RELATIONAL_SCHEMA_V4_TABLES,
    ...RELATIONAL_SCHEMA_V5_TABLES,
    ...RELATIONAL_SCHEMA_V8_TABLES,
    ...RELATIONAL_SCHEMA_V9_TABLES,
    ...RELATIONAL_SCHEMA_V10_TABLES,
    ...RELATIONAL_SCHEMA_V11_TABLES,
    ...RELATIONAL_SCHEMA_V12_TABLES
  ].flatMap((definition) => [
    { table: definition.name, column: null, comment: definition.comment },
    ...definition.columns.map((item) => ({ table: definition.name, column: item.name, comment: item.comment }))
  ]);
}
