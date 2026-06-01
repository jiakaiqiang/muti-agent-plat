# Vue 前端架构与目录规范

本文档描述当前项目 `apps/web` 的真实前端结构，并约束后续 Vue 代码的组织方式。前端应服务于“多 Agent 协同工作平台”的工作台体验：信息密度高、状态清晰、操作可追踪，避免做成营销页或装饰性页面。

## 技术栈

- 框架：Vue 3，使用 `<script setup lang="ts">`。
- 构建：Vite 6。
- 路由：Vue Router 4，使用 history 模式。
- 状态管理：Pinia。
- UI 基础库：Element Plus。
- 图标：`@lucide/vue`，项目内统一通过 `UiIcon.vue` 封装使用。
- 类型契约：优先从 `@agent-cluster/shared` 引入，并在 `src/types/contracts.ts` 聚合前端视图类型。
- API：原生 `fetch` 封装在 `src/api/client.ts`。
- 实时事件：浏览器 `EventSource` 连接后端 SSE。

入口文件：

- `apps/web/src/main.ts` 创建 Vue app、注册 Pinia 和 Vue Router、加载 Element Plus 样式和全局样式。
- `apps/web/src/App.vue` 只挂载 `RouterView`。
- `apps/web/src/router/index.ts` 定义工作台一级路由，并通过 route meta 映射到 `SessionWorkspace` 的当前 section。
- `apps/web/vite.config.ts` 配置 `@` alias 和 `@agent-cluster/shared` 源码 alias，`envDir` 指向仓库根目录。

## 当前目录结构

```text
apps/web/src
├── App.vue
├── main.ts
├── styles.css
├── api
│   └── client.ts
├── components
│   ├── AgentPortrait.vue
│   ├── AgentStatusPanel.vue
│   ├── ArtifactPanel.vue
│   ├── ChatTimeline.vue
│   ├── CollaborationGraphView.vue
│   ├── CollaborationLogPanel.vue
│   ├── ConfirmationCard.vue
│   ├── DebugRuntimeView.vue
│   ├── DirectoryPicker.vue
│   ├── ModelManagementPanel.vue
│   ├── SessionSidebar.vue
│   ├── SessionWorkspace.vue
│   ├── UiIcon.vue
│   ├── UserInputBox.vue
│   └── WorkflowRuntimeView.vue
├── router
│   └── index.ts
├── stores
│   ├── agent.ts
│   ├── event.ts
│   ├── knowledge.ts
│   ├── model.ts
│   └── session.ts
└── types
    └── contracts.ts
```

当前已接入 Vue Router。应用仍是单页工作台，一级 URL 路由负责切换左侧 rail 区域，工作台内部的对话/工作流/调试视图使用 `?view=` 查询参数同步。

## 路由结构

路由定义位于 `src/router/index.ts`。

| URL | Route name | Section | 说明 |
| --- | --- | --- | --- |
| `/` | redirect | `session` | 重定向到 `/sessions` |
| `/sessions` | `workspace-session` | `session` | 多 Agent 会话工作台 |
| `/knowledge` | `workspace-knowledge` | `knowledge` | 知识库 |
| `/agents` | `workspace-agents` | `agents` | Agent 管理 |
| `/settings` | `workspace-settings` | `settings` | 设置 |
| `/models` | `workspace-models` | `models` | 模型管理 |
| `/tools` | `workspace-tools` | `tools` | 工具集成 |
| `/notifications` | `workspace-notifications` | `notifications` | 通知中心 |
| `/:pathMatch(.*)*` | redirect | `session` | 未匹配路径回到 `/sessions` |

工作台子视图通过查询参数控制：

```text
/sessions?view=chat
/sessions?view=workflow
/sessions?view=collaboration_graph
/sessions?view=debug
```

`SessionWorkspace.vue` 使用 `useRoute()` 读取 `route.meta.section`，使用 `useRouter()` 在 rail 点击时跳转到对应路由。切换工作台 view mode 时同步更新 `?view=`，方便刷新和分享当前视图。

## 应用骨架

`SessionWorkspace.vue` 是当前前端的组合根，负责：

- 初始化 agent、capability、knowledge、model、session 数据。
- 选择当前 session 并连接 SSE。
- 控制左侧 rail 一级区域：工作台、知识库、Agent 管理、设置、模型管理、工具集成、通知中心。
- 控制工作台视图模式：对话、协同看板、工作流、调试。
- 编排会话创建、用户消息发送、简报确认/修订、暂停/继续/取消、文件写入确认、飞书通知确认。

工作台主结构：

```text
SessionWorkspace
├── app rail
├── SessionSidebar
├── main workspace
│   ├── ChatTimeline + UserInputBox
│   ├── CollaborationGraphView
│   ├── WorkflowRuntimeView
│   └── DebugRuntimeView
└── side panel
    ├── ConfirmationCard
    ├── AgentStatusPanel
    └── ArtifactPanel
```

## 组件职责

| 组件 | 职责 |
| --- | --- |
| `SessionWorkspace.vue` | 应用工作台容器、视图切换、业务动作编排 |
| `SessionSidebar.vue` | 会话列表、选择、删除、会话摘要状态 |
| `ChatTimeline.vue` | 将事件派生出的聊天消息渲染为对话流 |
| `UserInputBox.vue` | 用户输入和发送 |
| `ConfirmationCard.vue` | 用户确认卡片，包括简报确认、文件写入、通知发送等 |
| `AgentStatusPanel.vue` | Agent 当前状态、日志、RAG、能力使用 |
| `AgentPortrait.vue` | Agent 头像/身份展示 |
| `CollaborationGraphView.vue` | 协同图视图 |
| `WorkflowRuntimeView.vue` | 任务、runtime、工具执行进度视图 |
| `CollaborationLogPanel.vue` | 非对话视图旁侧事件/任务日志 |
| `DebugRuntimeView.vue` | 开发态调试数据面板 |
| `ArtifactPanel.vue` | 会话产物列表、详情和下载 |
| `DirectoryPicker.vue` | 创建会话时选择本地运行环境目录，只记录路径，不上传文件 |
| `ModelManagementPanel.vue` | 模型连接、模型发现和模型配置管理 |
| `UiIcon.vue` | 图标统一封装 |

## 状态管理

Pinia store 按领域划分：

| Store | 职责 |
| --- | --- |
| `session.ts` | 会话列表、当前会话、视图模式、会话控制 API |
| `event.ts` | 会话事件缓存、SSE 连接、事件到视图状态的派生 |
| `agent.ts` | Agent 列表、能力列表、Agent 创建/删除 |
| `knowledge.ts` | 知识库列表和知识库名称映射 |
| `model.ts` | 模型连接、模型定义、模型发现和删除 |

数据流：

```text
组件交互
  -> Pinia action
  -> api/client.ts
  -> Nest API
  -> store state 更新
  -> computed getter 派生视图模型
  -> Vue component 渲染
```

实时事件流：

```text
eventStore.connectSse(sessionId)
  -> EventSource /sessions/:sessionId/events/stream
  -> collaboration-event
  -> appendEvent()
  -> chatMessages / agentCards / taskStates / activeConfirmation
  -> ChatTimeline / AgentStatusPanel / WorkflowRuntimeView / ConfirmationCard
```

`event.ts` 是前端事件投影层，负责把后端 `CollaborationEvent` 派生成：

- `ChatMessage[]`
- `AgentCardState[]`
- `TaskViewState[]`
- `ConfirmationCardState`
- 当前任务简报

后续新增事件类型时，必须同步更新 `eventTypeToMessageType` 和相关 getter，否则 UI 可能收到了事件却不可见。

## API 与环境变量

`src/api/client.ts` 统一封装：

- `apiGet`
- `apiPost`
- `apiPatch`
- `apiDelete`
- `apiPage`
- `eventStreamUrl`
- `artifactDownloadUrl`
- `parseSseEvent`

环境变量：

- `VITE_API_BASE_URL`，默认 `http://127.0.0.1:3000/api`
- `VITE_SSE_BASE_URL`，默认复用 `VITE_API_BASE_URL`

规则：

- 组件不要直接调用 `fetch`，应通过 store 或 `api/client.ts`。
- 新增后端接口时，优先在对应 store 中封装 action，再由组件调用。
- API 错误应转成用户可读的中文错误信息，避免只在 console 中输出。
- SSE 连接切换 session 前必须关闭旧连接，避免重复事件和内存泄漏。

## 会话运行环境目录

新建会话时的目录选择不是上传入口。它表示本次会话的运行环境根目录：

- 研发类 Agent 后续读取、修改、测试代码时，都以整个目录作为 workspace root。
- 运营、通知、文案等非研发岗位如果需要读取或生成运行文件，也以该目录作为运行环境。
- 前端只记录本地绝对路径并提交给后端的 `workspaceDir` 字段，不上传目录内容。
- 后端 runtime 和工具执行必须继续通过 workspace sandbox 限制所有文件读写都在该目录内。
- 留空时使用后端默认 `AGENT_WORKSPACE_ROOT` 或进程工作目录。

## 类型与契约

`src/types/contracts.ts` 是前端类型出口：

- 从 `@agent-cluster/shared` 重新导出后端共享类型。
- 定义前端视图专用类型，如 `SessionViewMode`、`ChatMessage`、`AgentCardState`、`TaskViewState`、`ConfirmationCardState`。
- 定义事件 payload 的前端读取结构。

规则：

- 服务端契约变化先改 `packages/shared/src/contracts.ts`，前端再按需扩展 view model。
- 禁止使用 `any`。对未知后端 payload 使用 `unknown` 或 `Record<string, unknown>` 后收窄。
- 不要在组件里复制后端 contract 类型；统一从 `@/types/contracts` 引入。

## 样式系统

全局样式集中在 `src/styles.css`，Element Plus 样式先加载，项目样式后加载以覆盖默认样式。

设计方向：

- 这是工作台和运营工具，不是 landing page。
- 信息布局应紧凑、可扫描、可反复操作。
- 页面主结构使用 rail、sidebar、main、aside 等稳定区域。
- 卡片只用于重复项、确认卡、面板内对象，不要把页面 section 层层包成卡片。
- 颜色、间距、圆角、按钮尺寸应复用现有样式，不新增割裂的主题。
- 文案必须中文，和后端当前“中文 Agent/聊天 UX”保持一致。

交互控件约束：

- 图标按钮通过 `UiIcon.vue` 和 lucide 图标实现。
- 模式切换使用分段按钮或清晰 tab。
- 二元状态使用开关或明确按钮。
- 数字输入使用 input/stepper，不用自由文本伪装。
- 文本不能在移动端或窄容器中溢出按钮、标签、卡片。

## 当前架构债务

需要优先治理：

- `SessionWorkspace.vue` 约 920 行，已经混合应用 shell、路由状态、业务动作和多个管理页面。后续应拆出 `workspace`、`admin`、`session-actions` 或 composable。
- `ModelManagementPanel.vue` 约 480 行，继续新增模型表单逻辑前应拆分连接表单、模型表单、列表项。
- `DebugRuntimeView.vue` 约 339 行，调试数据请求和展示可以拆成 composable。
- `agent.ts` 当前存在调试 `console.log`，生产前应移除或改为统一调试日志策略。
- Vue Router 已接入，但所有一级页面仍复用 `SessionWorkspace.vue`。如果管理页继续扩张，应把 knowledge、agents、models 等管理区拆成独立 page component，再由 router 直接挂载。

## 新增前端功能流程

建议顺序：

1. 明确功能属于工作台视图、管理页、调试页还是通用组件。
2. 先确认后端 API 和 `@agent-cluster/shared` contract 是否存在。
3. 在对应 store 中新增 action 和必要 state/getter。
4. 新增或拆分组件，组件只接收清晰 props，向上 emit 用户动作。
5. 如需新增一级区域，先在 `router/index.ts` 添加 route，再更新 `SessionWorkspace.vue` 的 rail section。
6. 更新 `SessionWorkspace.vue` 的组合逻辑，避免继续把细节塞进主文件。
7. 更新 `styles.css`，优先复用现有 class 和布局规则。
8. 运行 `npm.cmd run build -w @project/web` 或仓库级 `npm.cmd run build`。

## 禁止事项

- 组件直接散落 `fetch`。
- 组件直接解析复杂后端事件而不经过 `eventStore` 投影。
- 在 store 或组件中使用 `any`。
- 生产代码保留 `console.log`。
- 新增超大组件继续堆到 `SessionWorkspace.vue`。
- 只改 rail 状态不改 route，导致 URL 和 UI 不一致。
- 新增英文用户可见文案，除非是模型名、技术名、错误码或外部品牌名。
- 新增大面积单色主题、装饰性背景、无信息价值的视觉元素。
- 把密钥、token、完整本地路径等敏感信息渲染到 UI。
