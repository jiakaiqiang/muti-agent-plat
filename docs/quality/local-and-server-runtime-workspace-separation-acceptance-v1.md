# Local/Server Runtime 双模式验收 v1

> 验收日期：2026-07-25
>
> 依据：[本地与服务器 Runtime 工作区隔离约定](../design/local-and-server-runtime-workspace-separation-discussion-result-v1.md)

## 1. 需求映射

| 需求 | 实现证据 | 状态 |
| --- | --- | --- |
| 产品只有本地和服务器两种模式 | UI 仅保留 `local_bridge`、`server_local`；默认本地 | 已实现 |
| 浏览器不是第三种 Runtime | 删除浏览器目录选择、Snapshot 上传、写回和兼容入口 | 已实现 |
| 本地模式使用本机 Runtime 和目录 | `/local-runtime` 将 invocation 发送给 CLI；CLI 管理本机授权工作区 | 已实现 |
| 服务器模式使用服务器 Runtime 和目录 | `server_local` 在服务器执行；Codex/Claude Code 路由到独立 `ServerRuntimeWorkerService` | 已实现 |
| 两种位置不互相降级 | RuntimeService 与 InvocationResolver 强制位置/Provider 匹配 | 已实现 |
| 平台仓库不是业务工作区 | server_local 路径安全规则拒绝平台源码范围 | 已实现 |
| 浏览器镜像链路退役 | 删除 BrowserWorkspaceMirrorService、workspace-broker transport 和 snapshot refresh API | 已实现 |
| 断线不中途自动重放 | Local Runtime/SSE 断线持久化 `INTERRUPTED` | 已实现 |

## 2. 合同断言

- `SessionWorkingDirectory.kind = 'local_bridge' | 'server_local'`。
- `ResolvedExecutionTarget.executionLocation = 'local' | 'server'`。
- `local_bridge` 只允许 `local`；`server_local` 只允许 `server`。
- `RuntimeWorkspaceExecution` 只保留服务器 Git worktree 证据，不再包含 `browser_mirror`。
- 历史 `browser_local` 数据启动时 fail closed，不进行静默迁移。
- `WorkspaceProviderKind` 与 Session 工作区合同都只包含 `local_bridge | server_local`。

## 3. UI 验收

- 新建会话只显示“本地”和“服务器”。
- 本地为默认值，并只选择 CLI 已注册工作区。
- 服务器模式显示服务器路径输入。
- 页面不存在“浏览器兼容”、浏览器目录授权、写回审核或镜像执行入口。
- 无当前会话时从聊天框发起任务，会先进入双模式建会对话框，不再隐式创建无目录工作区会话。

## 4. 自动化验证

本次改动的最小有效验证集合：

| 命令 | 目的 |
| --- | --- |
| `npm run typecheck` | Shared、Server、Local Runtime CLI 类型合同 |
| `npm run test` | 全 workspace 单元与守护测试 |
| `npm run test:harness` | Harness Engineering 与 v2-only 边界 |
| `npm run build` | Web、Server、Shared、CLI 构建 |
| `npm run test:e2e:runtime-workspace-separation` | 双模式选择、Local Runtime、Server Worker、恢复、取消与安全链路 |

最终执行结果以本次交付回复和命令输出为准。

## 5. 删除与兼容边界

已删除：

- 浏览器工作区前端 Store、WebSocket Broker、写回协调器和文件审核 UI；
- `/workspace-broker` WebSocket transport；
- Browser Workspace Mirror 服务及测试；
- `POST /api/sessions/:sessionId/workspace/snapshot`；
- 浏览器兼容模式选择 E2E。

仍保留：

- Local Runtime CLI 使用的通用 BrokerGateway/PendingRequestRegistry；
- 历史数据检测和明确的 cutover 错误；
- 历史 `browser_local` 数据检测，用于 fail-closed，不暴露为产品模式。
