# Workspace-Aware Agent Context v2 系统设计

## 1. 目标

本设计用于解决大型目录扫描不完整、Context 证据被裁剪、Runtime 输出不规范、分析报告无法完整交付，以及 Agent 与 Runtime/Model 耦合的问题。

已确认的产品决策：

- 先进行紧急修复，再切换长期架构。
- Context 使用“轻量 Push + 分层 Pull”。
- Agent Profile 与 Runtime/Model 解耦，Runtime 按阶段和任务动态选择。
- Chromium 第一阶段支持 Browser Workspace Broker。
- Codex/Claude 在 `server_local` 完整运行；`browser_local` 无 Bridge 时按能力降级或阻塞。
- `local_bridge` 第一阶段只预留合同。
- v2 只用于新会话，旧会话不迁移并允许清理。
- 架构报告完整展示，用户确认后才保存 Markdown。

## 2. 总体架构

```text
Vue Web
  ├─ Session Workspace
  ├─ Browser Workspace Broker
  ├─ Report Viewer / ChangeSet Preview
  └─ Permission UI
          │ REST + SSE + WebSocket
NestJS Server
  ├─ Session / Orchestrator / Task / Event
  ├─ ExecutionTarget Resolver
  ├─ Context Pipeline v2
  ├─ Runtime Adapter
  │    ├─ Generic LLM
  │    ├─ Codex
  │    ├─ Claude Code
  │    └─ Code Reader
  ├─ Workspace Provider Registry
  │    ├─ ServerLocalWorkspaceProvider
  │    ├─ BrowserBrokerWorkspaceProvider
  │    └─ LocalBridgeWorkspaceProvider (reserved)
  └─ Artifact → Review → Report → ChangeSet → Confirmation
```

## 3. 双平面模型

### 3.1 Context Plane

只决定当前 Runtime 调用可见的最小上下文：

```text
L0 Workspace Identity
L1 Navigation Manifest
L2 Project Map
L3 Selected Evidence
L4 Tool Results
L5 Summary Memory
L6 Delivery Artifacts
```

硬性约束：

- Navigation 不超过输入预算的 15%。
- Project Map 不超过 10%。
- Selected Evidence 应至少获得 40% 的预算。
- 需要源码依据的任务不得在 Evidence 为空时完成。
- Snapshot、Manifest、ProjectMap 不得重复携带同一批文件元数据。

### 3.2 Workspace Plane

保存完整工作区访问能力，不受 Context 裁剪影响。

```ts
interface WorkspaceProvider {
  kind: 'server_local' | 'browser_broker' | 'local_bridge'
  capabilities(): WorkspaceCapabilities
  getRevision(): Promise<WorkspaceRevision>
  listDirectory(input: ListDirectoryInput): Promise<ListDirectoryResult>
  statFile(input: StatFileInput): Promise<FileMetadata>
  readFile(input: ReadFileInput): Promise<ReadFileResult>
  searchText(input: SearchTextInput): Promise<SearchTextResult>
  applyChangeSet(input: WorkspaceChangeSet): Promise<ApplyChangeSetResult>
}
```

## 4. Agent、Runtime 与 Model

Agent 只定义角色、规则、Skill、Capability 和职责。实际执行目标由任务、阶段、Workspace 能力和用户偏好共同决定。

```ts
type ExecutionTarget = {
  runtimeType: RuntimeType
  modelId?: string
  source: 'task_override' | 'session_preference' | 'project_policy' | 'smart_router' | 'global_default'
  requiredCapabilities: string[]
  writeMode: 'none' | 'propose_changes' | 'direct_audited'
}
```

- Generic LLM 通过 WorkspaceProvider 工具获取文件。
- Codex/Claude 在 `server_local` 使用原生文件和命令工具。
- 架构师无论使用哪个 Runtime 都默认只读。
- `browser_local` 下分析任务可以降级 Generic LLM；必须执行命令的任务必须阻塞并要求 `server_local/local_bridge`。

## 5. WorkspaceIndex

WorkspaceIndex 保留完整导航和版本信息，但不全量进入 Prompt。

```ts
type WorkspaceIndexEntry = {
  path: string
  kind: 'file' | 'directory'
  size?: number
  language?: string
  hash?: string
  modifiedAt?: string
  generated: boolean
  sensitive: boolean
  module?: string
  symbols?: string[]
  imports?: string[]
}
```

## 6. Browser Workspace Broker

浏览器持有 `FileSystemDirectoryHandle`。后端通过 WebSocket 发送带 `requestId/sessionId/workspaceId/leaseId` 的操作请求，浏览器执行后返回结果。

支持的第一阶段操作：

- `list_directory`
- `stat_file`
- `read_file`
- `search_text`
- `apply_change_set`

权限失效时任务进入 `WAIT_WORKSPACE_PERMISSION`，必须由用户点击重新授权后继续。

## 7. 文件变更

所有平台代理写入统一使用 ChangeSet：

```ts
type WorkspaceChangeSet = {
  id: string
  workspaceId: string
  workspaceRevision: string
  sourceArtifactId: string
  changes: Array<{
    operation: 'create' | 'update' | 'delete' | 'move'
    path: string
    previousPath?: string
    content?: string
    baseHash?: string
    evidenceRefs: string[]
    reason: string
  }>
}
```

执行顺序：Read Before Write → baseHash 校验 → Diff 预览 → 用户确认 → 写入 → 重新读取验证 → Index 失效与重建。

## 8. Artifact 和报告交付

架构报告必须使用标准 Markdown Artifact，正文只能存放在顶层 `content`。

```ts
type ArchitectureReportArtifact = {
  type: 'markdown'
  title: '项目架构分析报告'
  content: string
  metadata: {
    reportKind: 'project_architecture_analysis'
    evidenceRefs: TaskEvidenceRef[]
    workspaceRevision: string
  }
}
```

报告先完整展示，再由用户选择保存路径并确认写入。保存过程不得重新调用模型。

## 9. 状态语义

- `needs_review`：结果实质完成，但需要质量复核。
- `blocked`：缺少证据、权限、Workspace 或 Runtime 能力，不得转为 `task_completed`。
- Workspace 相关等待状态包括 `WAIT_WORKSPACE_CLIENT`、`WAIT_WORKSPACE_PERMISSION`、`WAIT_WORKSPACE_CONTEXT` 和 `WAIT_FILE_CONFIRMATION`。

## 10. 版本与发布

- Session 固定记录 `contextPipelineVersion: 'v1' | 'v2'`。
- Feature Flag 控制 Context v2、Browser Broker、动态 Runtime 路由和严格 Artifact Schema。
- v2 只用于新会话；旧会话不迁移，允许在最终切换前清理。
- Debug/Health 必须显示 Git commit、构建时间、合同版本和 Pipeline 版本。

## 11. 完成定义

- 1000+ 文件目录仍可定位核心入口和模块。
- 需要源码依据时 Evidence 不为空。
- GLM 证据不足时请求补读而不是猜测完成。
- Browser Broker 可补读未预扫描文件并恢复权限。
- Codex/Claude 在 `server_local` 可完成真实读写、测试与 Diff 捕获。
- Agent 切换 Runtime 后角色、Skill 和 Capability 不变。
- 报告完整展示，保存文件与显示正文完全一致。
