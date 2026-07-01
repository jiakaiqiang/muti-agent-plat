# Agent Cluster 协作系统 PRD v1

## 1. 背景

当前研发人员在使用 AI 工具完成复杂任务时，常见问题包括：

- 用户用自然语言表达需求后，AI 容易直接执行，缺少任务共识确认。
- 单个 Agent 难以覆盖需求理解、架构判断、代码执行、测试验证、复盘交付等完整链路。
- 多 Agent 协作过程不可见，用户不知道谁在做什么、为什么这么做、是否出现分歧。
- 上下文、记忆、工具权限和 token 消耗缺少统一管理，任务越复杂越容易失控。
- Codex、Claude Code 等成熟 coding agent 能力强，但缺少一个上层协作调度与可视化管理平台。

因此需要建设一个以多 Agent 协作为核心的任务执行系统，让用户像管理一个 Agent 工作群一样，提出目标、参与澄清、确认任务契约、观察执行过程，并在 Agent 复盘一致后获得最终交付。

## 2. 产品定位

Agent Cluster 是一个面向研发人员起步的多 Agent 协作任务系统。

用户通过自然语言下发任务，多个不同身份的 Agent 先进行讨论并形成任务理解稿，用户确认后再进入执行。执行过程中，Agent 之间可以像工作群一样相互 @、派发任务、请求联调、反馈问题、打回返工。任务完成后，Agent 再次讨论并对比“执行前任务契约”和“实际执行结果”，确认一致后再交付用户。

系统支持三种过程查看模式：

- 群聊模式：像微信群聊一样查看 Agent 之间的协作沟通。
- 协作流转可视化模式：以 Agent 节点、信息流、气泡方式展示 Agent 之间的信息流转。
- 工作流模式：以类似 Dify 的流程图方式展示阶段进度和任务流转。

第一阶段重点服务研发人员，后续扩展到产品、运营、数据分析等场景。

## 3. 目标

### 3.1 产品目标

- 支持用户用自然语言创建一个多 Agent 协作会话。
- 支持多个 Agent 先讨论任务、形成任务理解稿，并等待用户确认。
- 支持用户在确认前持续和 Agent 团队沟通、修正任务理解。
- 支持用户确认后，由 Coordinator 统一拆分和分配任务，子 Agent 接受、阻塞或拒绝分配后再执行。
- 支持执行过程中以群聊、协作流转图、工作流图三种方式查看进度。
- 支持 Agent 执行完成后进行复盘一致性检查。
- 支持将最终结果、过程记录、产物和风险总结交付给用户。
- 支持 Agent 调用外部系统能力，例如代码仓库、本地命令、飞书通知、MCP 工具等。

### 3.2 技术目标

- 前端使用 Vue 3+element-plus+typescript+pinia。
- 后端使用 NestJS+redis。
- 数据库使用 PostgreSQL。
- 第一阶段不做多用户管理，但保留 owner、workspace 等扩展字段。
- Agent 身份与模型/Runtime 解耦，支持 Codex、Claude Code、通用 LLM、MCP Tool 等运行后端。
- 通过统一事件流管理群聊、任务状态、Agent 状态和可视化数据。

## 4. 非目标

第一阶段暂不做：

- 多租户和复杂团队权限。
- 工作流市场。
- 计费系统。
- 自动选择所有工作流模板。
- 复杂组织审批。
- 大规模分布式 Agent 运行集群。
- 子 Agent 之间自动转派任务。
- 多 Agent 自由竞争抢占任务。
- 完整替代 Codex 或 Claude Code 的 coding agent 能力。

## 5. 用户画像

### 5.1 第一阶段用户

研发人员。

典型需求：

- 让 Agent 团队分析需求并给出技术方案。
- 让 Agent 团队修复 bug。
- 让 Agent 团队重构某个模块。
- 让 Agent 团队执行代码审查。
- 让 Agent 团队补充测试并总结结果。
- 让 Agent 团队完成后生成飞书通知或总结报告。

### 5.2 后续用户

产品人员：

- PRD 生成。
- 需求拆解。
- 竞品分析。
- 用户反馈整理。

运营人员：

- 内容选题。
- 活动方案。
- 数据分析。
- 自动生成飞书日报、周报。

## 6. 核心概念

### 6.1 协作会话 Session

一次用户发起的多 Agent 协作任务。

会话包含：

- 用户原始需求。
- Agent 讨论记录。
- 任务理解稿。
- 用户确认记录。
- 执行任务池。
- Agent 状态。
- 工具调用记录。
- 产物。
- 复盘报告。
- 最终交付。

### 6.2 Agent

Agent 是系统定义的协作角色，不直接等同于某个模型。

Agent 包含：

- 名称。
- 身份。
- 职责。
- 系统提示词。
- 可用能力。
- 可用工具。
- 记忆访问范围。
- RAG 知识库访问范围。
- Runtime 策略。
- token 预算。
- 安全权限。

示例 Agent：

- Coordinator Agent：协调任务、组织讨论、推进状态。
- 需求 Agent：理解用户目标、澄清范围。
- 架构 Agent：评估技术方案、风险和边界。
- 前端 Agent：负责前端实现。
- 后端 Agent：负责后端实现。
- 测试 Agent：负责测试计划、执行和验证。
- Review Agent：负责代码审查和一致性检查。
- 通知 Agent：负责飞书等外部通知。

### 6.3 Agent Runtime

Agent Runtime 是 Agent 背后的执行后端。

第一阶段支持抽象：

- Generic LLM Runtime：用于需求、架构、复盘、总结。
- Codex Runtime：用于代码修改、读仓库、跑测试等工程任务。
- Claude Code Runtime：用于代码理解、重构、工程分析。
- MCP Tool Runtime：用于调用外部 MCP 工具。
- Human Runtime：用于等待用户确认或人工输入。

### 6.4 任务契约 Task Brief

Agent 执行前形成并经用户确认的任务理解稿。

任务契约包含：

- 用户目标。
- 执行范围。
- 明确不做事项。
- 约束条件。
- 验收标准。
- 风险点。
- 预计分工。
- 需要用户确认的问题。

任务契约是执行后复盘一致性检查的基准。

### 6.5 协作事件 Collaboration Event

系统底层使用统一事件流记录所有协作过程。

事件类型包括：

- 用户消息。
- Agent 消息。
- Agent @ Agent。
- Agent @ 用户。
- 任务创建。
- 任务分配。
- 任务接受。
- 任务阻塞。
- Coordinator 改派。
- 任务完成。
- 任务打回。
- 工具调用。
- 产物生成。
- 用户确认。
- 状态变化。
- 复盘结论。

三种可视化模式都基于同一份事件流渲染。

### 6.6 RAG 知识库

RAG 知识库用于让用户主动给 Agent 补充可检索知识。

RAG 与 Memory 的边界：

- RAG：用户或系统导入的外部知识材料，例如项目文档、接口文档、业务规则、历史 PRD、飞书文档、代码规范、运营手册。
- Memory：系统从协作过程中沉淀出来的事实、偏好、经验和历史决策。

每个 Agent 可以拥有自己的专属 RAG 知识库，也可以访问项目级、会话级、全局级知识库。

知识库作用域：

- Global RAG：全局通用知识，例如公司规范、通用研发规范。
- Project RAG：项目级知识，例如项目架构、接口文档、部署说明。
- Session RAG：当前会话临时补充资料，例如用户上传的一份需求文档。
- Agent RAG：某个 Agent 的专属知识，例如测试 Agent 的测试规范、架构 Agent 的架构原则。

Agent 执行前，Context Manager 会根据当前任务、Agent 身份和权限，从对应 RAG 知识库中检索相关片段，并作为 Context Pack 的一部分注入给 Agent。

## 7. 核心流程

### 7.1 创建协作会话

1. 用户点击新建会话。
2. 用户输入自然语言任务。
3. 系统创建 session。
4. Coordinator Agent 接收任务。
5. 系统选择默认研发 Agent 团队参与讨论。

### 7.2 Agent 讨论与任务理解

1. Coordinator Agent 组织 Agent 团队讨论。
2. 需求 Agent 提炼目标、边界和待确认问题。
3. 架构 Agent 评估技术影响和风险。
4. 执行类 Agent 判断可行性和依赖。
5. 测试 Agent 提出验收标准。
6. Coordinator Agent 汇总形成任务契约。
7. 系统将任务契约以确认卡片形式展示给用户。

### 7.3 用户确认与继续沟通

用户可以：

- 确认执行。
- 继续补充需求。
- 修改任务范围。
- 指定某个 Agent 回答。
- 删除某个执行项。
- 暂停会话。

如果用户继续沟通：

1. 新消息进入事件流。
2. Agent 重新讨论。
3. 任务契约更新。
4. 系统再次等待用户确认。

### 7.4 多 Agent 执行

用户确认后：

1. Coordinator Agent 将任务拆分为动态任务池。
2. Coordinator Agent 为每个任务指定负责 Agent，并写入分配事件。
3. 子 Agent 接受、阻塞或拒绝分配；阻塞或拒绝时只能返回原因和建议交接。
4. Coordinator 自动处理一次阻塞或拒绝，仍失败则进入用户决策。
5. Agent 之间通过群聊消息协作。
6. 需要联调、评审、依赖交付时使用 @ 机制。
7. 任务计划和任务卡片应同步展示分配理由、上下文需求、计划验证方式和风险提示；若某任务执行前需要用户确认，应在卡片中明确标记。
7. 执行类 Agent 可以调用 Codex、Claude Code、MCP、飞书等 Runtime 或工具。
8. 所有执行动作写入事件流。
9. 前端实时展示群聊、Agent 卡片状态和可视化进度。

### 7.5 执行后复盘一致性检查

任务完成后：

1. Coordinator Agent 组织复盘。
2. Review Agent 对比任务契约和实际结果。
3. 测试 Agent 对比验收标准和测试结果。
4. 执行 Agent 汇报完成内容和变更。
5. 通知 Agent 检查通知内容是否符合用户确认。
6. 系统生成复盘报告。

如果一致：

- 进入最终交付。

如果不一致：

- 进入返工或等待用户决策。

### 7.6 最终交付

最终交付包含：

- 完成摘要。
- Agent 复盘结论。
- 已完成事项。
- 未完成事项。
- 超范围变更。
- 测试结果。
- 产物链接。
- 风险提示。
- 后续建议。

### 7.7 用户消息处理协议

用户在 Agent 群中的每一次发言都不是普通聊天，而是一个高优先级协作事件。

用户消息进入系统后的统一流程：

```text
用户消息
  -> 写入协作事件流
  -> User Message Router 识别意图
  -> Coordinator 判断影响范围
  -> 必要时暂停相关 Agent 或任务
  -> 通知受影响 Agent
  -> Agent 讨论或执行处理
  -> 更新任务契约、任务池或会话状态
  -> 向用户反馈处理结果
```

用户消息类型：

- clarification：澄清或补充需求。
- constraint：新增约束，例如“不要修改数据库”。
- command：操作命令，例如“暂停”“继续”“重试”。
- question：向 Agent 提问。
- correction：纠偏或否定当前方向。
- knowledge\_input：补充知识材料，可进入会话上下文或 RAG。
- preference\_input：表达偏好，可询问用户是否写入 Memory。

执行前处理策略：

- 新需求：创建会话目标，并召集相关 Agent 讨论。
- 补充需求：更新当前任务理解，重新生成任务契约。
- 新约束：写入会话约束，并要求 Agent 评估影响。
- 提问：路由给相关 Agent 回答。
- 补充知识：进入 Session RAG 或临时上下文。

执行中处理策略：

- 用户最新明确要求优先于 Agent 当前计划。
- 普通问题不一定暂停任务，只路由给相关 Agent 回答。
- 新增约束需要检查是否影响已执行内容。
- 纠偏类消息需要暂停受影响任务，并重新讨论。
- 与已确认任务契约冲突的消息，需要进入 WAIT\_USER\_DECISION。
- 涉及范围、验收标准或高风险工具调用变化时，需要重新确认任务契约。

示例：

```text
用户：不要改数据库。

Coordinator Agent：
收到用户新增约束：“不要修改数据库结构”。
@架构 Agent 请评估是否影响当前方案。
@后端 Agent 暂停涉及数据库的改动。
@测试 Agent 更新验收标准。

架构 Agent：
该约束影响原方案中的 login_audit 字段设计，建议移除该部分。

后端 Agent：
收到，当前尚未产生数据库 migration，我会调整实现方案。

测试 Agent：
我会增加检查项：确认没有新增 migration。

Coordinator Agent：
已更新任务约束：不修改数据库结构。
影响：移除 login_audit 方案。
当前无需返工，因为尚未产生数据库变更。
是否继续执行？
```

核心规则：

- 用户消息必须先进入事件流。
- Coordinator 负责解释和路由，避免所有 Agent 同时抢答。
- 涉及任务范围、约束、验收标准变化时，必须更新任务契约。
- 执行中新增要求必须做影响分析。
- 如果新要求和已确认任务契约冲突，暂停相关任务并请求用户确认。
- 所有 Agent 对用户新增要求的处理过程必须在群聊中可见。

## 8. 会话状态机

```text
DRAFT_INPUT
  用户刚输入需求

AGENT_DISCUSSING
  Agent 正在讨论和理解任务

WAIT_USER_CONFIRM
  等待用户确认任务契约

REVISING_BRIEF
  用户补充后，Agent 重新讨论并修订任务契约

EXECUTING
  Agent 正在执行任务

POST_REVIEW
  执行后复盘一致性检查

REWORKING
  发现不一致，Agent 正在返工

WAIT_USER_DECISION
  需要用户决策后才能继续

COMPLETED
  任务完成并交付

FAILED
  任务失败或无法继续

CANCELLED
  用户取消
```

## 9. 页面设计

### 9.1 群聊主界面

群聊模式是第一阶段主界面。

页面分三栏：

```text
左侧栏：操作区 + 会话历史
中间栏：群聊消息
右侧栏：正在执行任务的 Agent 卡片
```

### 9.2 左侧栏

左侧栏分上下两部分。

上方 30%：操作区。

功能：

- 新建会话。
- 添加 Agent。
- 添加技能。
- 添加 RAG 知识。
- 添加 MCP 能力。
- 选择协作模式。
- 选择当前视图：群聊、协作流转、工作流。
- 导入上下文。

下方 70%：对话历史。

展示：

- 当前会话。
- 历史会话。
- 等待用户确认的会话。
- 执行中的会话。
- 已完成会话。
- 失败会话。

会话列表项展示：

- 会话标题。
- 当前状态。
- 参与 Agent 数量。
- 最近更新时间。
- 是否需要用户操作。

### 9.3 中间群聊区

展示多 Agent 协作消息。

消息类型：

- 用户消息。
- Agent 消息。
- Agent @ Agent。
- Agent @ 用户。
- 任务派发卡片。
- 任务完成卡片。
- 工具调用卡片。
- 用户确认卡片。
- 复盘结论卡片。
- 文件变更卡片。
- 错误和告警卡片。

输入框能力：

- 普通输入。
- @ 指定 Agent。
- 暂停执行。
- 继续执行。
- 确认任务契约。
- 要求重新讨论。

消息过滤：

- 全部。
- 用户确认。
- 任务变更。
- 工具调用。
- 异常。
- 指定 Agent。

### 9.4 右侧 Agent 状态区

右侧以 card 展示当前会话中参与任务的 Agent。

每个卡片展示：

- Agent 名称。
- Agent 角色。
- 当前状态。
- 当前任务。
- 思考摘要。
- 正在执行的动作。
- 最近行动日志。
- 等待对象。
- 使用中的工具。
- 产物。
- 操作按钮。

状态包括：

- 空闲。
- 讨论中。
- 思考中。
- 执行中。
- 等待中。
- 评审中。
- 返工中。
- 已完成。
- 失败。

注意：右侧展示的是可审计的思考摘要、计划和行动日志，不展示隐藏推理链。

### 9.5 协作流转可视化模式

左侧主区域展示 Agent 节点和信息流转。

表现形式：

- Agent 作为节点。
- Agent 消息作为气泡。
- @、交付、联调、打回等作为流线。
- 当前活跃 Agent 高亮。
- 阻塞 Agent 显示等待原因。

右侧展示对话记录和选中事件详情。

支持：

- 点击 Agent 过滤相关消息。
- 点击流线查看对应对话。
- 点击气泡定位事件。

### 9.6 工作流模式

展示类似 Dify 的阶段流程图。

第一阶段流程图可以由系统根据任务契约和动态任务池生成，而不是完全由用户预先搭建。

展示内容：

- 任务理解。
- 用户确认。
- 架构设计。
- 执行任务。
- 联调。
- 测试。
- Review。
- 复盘。
- 交付。

每个节点展示状态和关联 Agent。

## 10. 上下文管理

系统不把完整群聊历史传给每个 Agent。

原则：

- 统一保存事件事实。
- 每次 Agent 执行前动态组装 Context Pack。
- 不同 Agent 获取不同上下文。
- 任务契约高于长期记忆。
- 用户最新指令高于历史信息。

Context Pack 包含：

- 系统规则。
- 当前会话目标。
- 已确认任务契约。
- 当前任务。
- 该 Agent 职责。
- 与该 Agent 相关的消息。
- 依赖关系。
- 关键产物摘要。
- 相关长期记忆。
- 相关 RAG 检索结果。
- 可用工具列表。
- 安全约束。

## 11. Memory 管理

Memory 不等于聊天历史。

记忆类型：

- 短期记忆：当前协作中刚发生的事情。
- 会话记忆：当前会话内已经达成共识的事实。
- 长期记忆：跨会话复用的稳定知识。
- 项目记忆：项目技术栈、规范、目录结构。
- 用户记忆：用户偏好。
- Agent 记忆：某类 Agent 的执行经验。
- 工具记忆：外部系统配置和常见失败原因。

Agent 不直接管理记忆。

流程：

1. 事件流记录发生过什么。
2. Memory Manager 判断什么值得记。
3. Context Manager 决定这次给 Agent 看什么。
4. Agent 只使用被注入的记忆包。

长期记忆写入策略：

- 短期记忆自动写入。
- 会话记忆由用户确认或任务契约生成。
- 长期记忆第一阶段需要用户确认。

## 11.5 RAG 知识管理

RAG 知识管理负责将用户补充的知识变成 Agent 可检索、可引用、可追溯的上下文。

RAG 知识来源：

- 用户上传文件。
- 用户粘贴文本。
- 用户导入飞书文档。
- 用户导入接口文档。
- 用户导入项目规范。
- 系统从代码仓库生成的项目说明。

知识绑定方式：

- 绑定到全局。
- 绑定到项目。
- 绑定到当前会话。
- 绑定到指定 Agent。
- 绑定到指定 Agent 角色类型，例如所有测试 Agent。

每个 Agent 的 RAG 配置包含：

- 默认可访问知识库。
- 专属知识库。
- 检索 topK。
- 相似度阈值。
- 是否允许跨 Agent 知识库检索。
- 是否需要用户授权后访问敏感知识。

RAG 检索流程：

1. 用户补充知识后，系统创建 knowledge source。
2. 系统对文档进行解析、切分、向量化和索引。
3. Agent 执行前，Context Manager 根据任务生成检索 query。
4. RAG Retriever 按 Agent 权限检索相关知识片段。
5. Context Manager 对命中的知识片段进行去重、排序和摘要。
6. 检索结果注入 Agent 的 Context Pack。
7. Agent 输出时标记引用的知识来源。

RAG 与 Memory 的使用优先级：

- 当前用户最新指令高于 RAG。
- 已确认任务契约高于 RAG。
- 会话记忆高于历史 RAG。
- RAG 可补充事实，但不能覆盖用户本次明确约束。
- 如果 RAG 与任务契约冲突，Agent 需要报告冲突并等待 Coordinator 判断。

## 12. Token 与成本管理

系统需要做外层预算管理，不替代 Codex、Claude Code 等成熟 Agent 内部 token 优化。

预算层级：

- 会话预算。
- 阶段预算。
- Agent 预算。
- 任务预算。
- Runtime 调用预算。

每次模型调用前执行 Token Preflight：

- 估算输入 token。
- 估算输出 token。
- 检查剩余预算。
- 决定是否压缩上下文。
- 决定是否降级模型。
- 决定是否暂停并请求用户确认。

优化策略：

- 群聊消息阶段性摘要。
- 工具结果保存原文，传递摘要。
- Agent 只拿相关上下文。
- 执行 Agent 拿精准任务包。
- Review Agent 只拿任务契约、diff、测试结果。
- 普通通知使用轻量模型。
- 高风险决策使用强模型。

## 13. MCP 与技能管理

全局 MCP 和技能通过 Capability Registry 管理。

能力类型：

- mcp。
- tool。
- skill。
- connector。
- runtime。

能力字段：

- 名称。
- 描述。
- 输入 schema。
- 输出 schema。
- 风险等级。
- 所属 MCP server。
- 适用 Agent。
- 是否需要用户确认。
- 是否需要凭证。
- 权限范围。

风险等级：

- 低风险：读取、搜索、总结。
- 中风险：创建文档、生成草稿、发送预览。
- 高风险：修改文件、运行命令、发送外部通知、创建 PR。

调用链路：

```text
Agent
  -> Capability Manager
  -> Permission Policy
  -> Runtime / MCP / Connector
  -> Invocation Log
  -> Collaboration Event
```

第一阶段建议能力：

- read\_file。
- search\_code。
- edit\_file。
- run\_test。
- run\_command。
- git\_diff。
- feishu\_send\_message。
- feishu\_create\_doc。

## 14. 系统架构

```text
Vue 3 Frontend
  - Chat Workspace
  - Agent Status Cards
  - Collaboration Graph
  - Workflow View

NestJS Backend
  - Session Module
  - Agent Module
  - Collaboration Event Module
  - User Message Router Module
  - Context Module
  - Memory Module
  - RAG Knowledge Module
  - Runtime Module
  - Capability Module
  - Token Budget Module
  - Artifact Module
  - Notification Module

Runtime Layer
  - Generic LLM Runtime
  - Codex Runtime
  - Claude Code Runtime
  - MCP Tool Runtime
  - Feishu Connector

PostgreSQL
  - sessions
  - agents
  - events
  - tasks
  - memories
  - knowledge_bases
  - knowledge_documents
  - knowledge_chunks
  - artifacts
  - invocations
  - budgets
```

## 15. 数据模型草案

### 15.1 agents

- id。
- name。
- role。
- description。
- system\_prompt。
- runtime\_type。
- runtime\_config。
- capability\_ids。
- rag\_policy。
- default\_knowledge\_base\_ids。
- memory\_policy。
- budget\_policy。
- status。
- created\_at。
- updated\_at。

### 15.2 sessions

- id。
- title。
- original\_input。
- status。
- owner\_id。
- workspace\_id。
- current\_task\_brief\_id。
- token\_budget。
- token\_used。
- created\_at。
- updated\_at。

### 15.3 collaboration\_events

- id。
- session\_id。
- type。
- user\_message\_intent。
- priority。
- from\_agent\_id。
- to\_agent\_ids。
- task\_id。
- content。
- metadata。
- created\_at。

### 15.3.1 user\_message\_handling\_plans

- id。
- session\_id。
- event\_id。
- intent。
- priority。
- should\_pause。
- affected\_task\_ids。
- affected\_agent\_ids。
- requires\_brief\_revision。
- requires\_user\_confirmation。
- coordinator\_instruction。
- status。
- created\_at。

### 15.4 task\_briefs

- id。
- session\_id。
- version。
- goal。
- scope。
- out\_of\_scope。
- constraints。
- acceptance\_criteria。
- risks。
- open\_questions。
- confirmed\_by\_user。
- confirmed\_at。
- created\_at。

### 15.5 agent\_tasks

- id。
- session\_id。
- title。
- description。
- status。
- assignee\_agent\_id。
- depends\_on\_task\_ids。
- acceptance\_criteria。
- result\_summary。
- created\_at。
- updated\_at。

### 15.6 memories

- id。
- scope。
- owner\_id。
- project\_id。
- session\_id。
- agent\_id。
- content。
- summary。
- embedding。
- confidence。
- source\_event\_id。
- expires\_at。
- created\_at。

### 15.7 knowledge\_bases

- id。
- name。
- description。
- scope。
- owner\_id。
- project\_id。
- session\_id。
- agent\_id。
- role\_type。
- visibility。
- embedding\_model。
- chunk\_strategy。
- created\_at。
- updated\_at。

### 15.8 knowledge\_documents

- id。
- knowledge\_base\_id。
- title。
- source\_type。
- source\_uri。
- content\_hash。
- status。
- metadata。
- created\_at。
- updated\_at。

### 15.9 knowledge\_chunks

- id。
- knowledge\_document\_id。
- knowledge\_base\_id。
- chunk\_index。
- content。
- summary。
- embedding。
- token\_count。
- metadata。
- created\_at。

### 15.10 agent\_knowledge\_bases

- id。
- agent\_id。
- knowledge\_base\_id。
- access\_level。
- retrieval\_policy。
- created\_at。

### 15.11 rag\_retrieval\_logs

- id。
- session\_id。
- task\_id。
- agent\_id。
- query。
- matched\_chunk\_ids。
- input\_tokens。
- output\_tokens。
- created\_at。

### 15.12 capability\_invocations

- id。
- session\_id。
- agent\_id。
- capability\_id。
- runtime\_type。
- input\_summary。
- output\_summary。
- status。
- risk\_level。
- token\_input。
- token\_output。
- cost。
- started\_at。
- ended\_at。

### 15.13 artifacts

- id。
- session\_id。
- task\_id。
- agent\_id。
- type。
- title。
- uri。
- content\_summary。
- metadata。
- created\_at。

## 16. MVP 范围

### 16.1 必须实现

- 创建协作会话。
- 研发默认 Agent 团队。
- 群聊式协作页面。
- 左侧操作区和历史会话。
- 中间群聊消息流。
- 右侧 Agent 状态卡片。
- Agent 讨论生成任务契约。
- 用户确认任务契约。
- 用户继续补充后重新生成任务契约。
- 用户消息处理协议。
- User Message Router 雏形。
- 执行中用户插话后的影响范围判断。
- 确认后进入执行。
- 执行事件写入事件流。
- 执行完成后复盘一致性检查。
- 最终交付卡片。
- 基础 Context Pack。
- 基础 Memory 分层。
- 基础 RAG 知识库。
- 支持给指定 Agent 绑定专属 RAG 知识。
- 支持用户上传或粘贴知识材料。
- Agent 执行前可检索自身 RAG 和项目 RAG。
- token 调用记录。
- Capability Registry 雏形。
- 飞书通知能力预留，第一阶段可先做草稿或 mock。

### 16.2 应该实现

- 协作流转可视化简版。
- 工作流视图简版。
- Agent @ 机制。
- 消息过滤。
- 工具调用卡片。
- 产物卡片。
- 用户确认卡片。
- 任务状态流转。
- RAG 命中来源展示。
- Agent 卡片展示已使用的知识库片段摘要。

### 16.3 可以后置

- 完整多用户权限。
- 工作流模板市场。
- 自动匹配业务场景。
- 复杂 MCP 权限审批。
- 多项目长期记忆管理后台。
- 复杂知识库权限。
- 知识库版本对比。
- 跨项目知识库共享。
- 成本报表。
- Agent 竞争接活。
- 复杂分布式执行。

## 17. 成功指标

第一阶段成功指标：

- 用户可以在 1 个页面完成从需求输入到任务交付。
- 用户可以清晰看到 Agent 如何讨论、分工、执行、复盘。
- 用户确认前，Agent 不会执行高风险操作。
- 执行后，系统可以明确说明实现是否符合任务契约。
- 所有关键动作都有事件记录。
- Agent 状态卡片能实时反映当前进度。
- 单次会话 token 消耗可统计、可展示。
- 用户可以为不同 Agent 补充不同 RAG 知识，Agent 执行时能按权限检索并引用。
- 新增 Agent、Runtime、MCP 能力不需要重构核心协作模型。

## 18. 第一阶段示例流程

用户输入：

```text
帮我重构登录模块，保持旧 token 兼容，完成后生成飞书通知。
```

Agent 讨论：

```text
需求 Agent：我理解目标是重构登录模块，但保持行为兼容。
架构 Agent：建议先分析 auth 模块边界，不能贸然修改数据库。
后端 Agent：我可以负责 token-service 和 auth-service 的代码修改。
测试 Agent：需要覆盖旧 token、验证码、刷新登录态场景。
通知 Agent：完成后我生成飞书通知草稿，发送前需要用户确认。
```

任务契约：

```text
目标：重构登录模块。
范围：auth-service、token-service。
不做：不修改数据库结构，不改变 token 返回结构。
验收：旧 token 兼容测试通过，登录流程回归通过。
通知：生成飞书草稿，发送前确认。
```

用户确认：

```text
确认执行。
```

执行过程：

```text
架构 Agent @后端 Agent：方案已完成，请按兼容约束实现。
后端 Agent：收到，开始修改 token-service。
测试 Agent：我等待后端完成后执行回归测试。
后端 Agent @测试 Agent：实现完成，请测试旧 token 兼容。
测试 Agent：测试通过。
Review Agent：实现与任务契约一致。
```

复盘：

```text
执行前约定：不修改数据库。
实际结果：未修改数据库。

执行前约定：保持旧 token 兼容。
实际结果：旧 token 回归测试通过。

执行前约定：飞书通知发送前确认。
实际结果：已生成草稿，未发送。
```

最终交付：

```text
Agent 团队复盘确认：实际结果与任务契约一致。
任务已完成。
```

## 19. 后续迭代方向

- 产品 Agent 团队模板。
- 运营 Agent 团队模板。
- Agent 自定义能力市场。
- 工作流协议编辑器。
- Agent 主动接活机制。
- 跨会话项目记忆。
- 飞书深度集成。
- GitHub/GitLab PR 集成。
- CI/CD 集成。
- 成本分析和模型路由优化。
