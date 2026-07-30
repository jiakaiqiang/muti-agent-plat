# 本地与服务器 Runtime 工作区隔离约定 v1

> 状态：已按双模式硬切换实现
>
> 更新时间：2026-07-25

## 1. 最终结论

产品只提供两种运行方式：

| 模式 | 用户入口 | Runtime 位置 | 工作目录位置 | 会话合同 |
| --- | --- | --- | --- | --- |
| 本地 | 浏览器访问平台 | 用户本机 Local Runtime CLI | CLI 已授权的本机目录 | `local_bridge` |
| 服务器 | 浏览器访问平台 | 服务器 Runtime Worker | 用户明确指定的服务器目录 | `server_local` |

浏览器只是统一的 UI 和控制入口，不是独立 Runtime，也不形成第三种工作区模式。

已退役的语义包括：

- `browser_local` 会话工作目录；
- UI 中的“浏览器兼容”模式；
- 浏览器目录上传 Snapshot 后由服务器 Runtime 执行；
- Browser Workspace Mirror、浏览器写回和 `/workspace-broker` 浏览器传输入口。

## 2. 架构边界

```text
本地模式
Browser UI -> Platform Backend (control plane) -> Local Runtime CLI -> local authorized directory

服务器模式
Browser UI -> Platform Backend (control plane) -> Server Runtime Worker -> selected server directory/worktree
```

平台后端负责 Session、Task、授权、Runtime 路由、事件、恢复和审计。业务文件只能由所选执行面在绑定工作区内访问，平台仓库和后端运行目录不得成为普通 Agent 的业务工作区。

## 3. 工作区合同

会话级合同只有：

```ts
type SessionWorkingDirectory = {
  kind: 'local_bridge' | 'server_local'
  id: string
  name: string
  path?: string
  selectedAt: string
}
```

约束：

- `local_bridge` 不向服务器暴露本机绝对路径；服务器只持有 `workspaceId`、能力、revision、设备和连接状态。
- `server_local` 必须由用户明确提供服务器可访问路径，并经过工作区边界、敏感目录和符号链接校验。
- 普通任务文本中的路径不得被隐式提升为 `server_local` 工作目录。
- 已持久化的 `browser_local` 会话必须 fail closed，并提示执行数据切换，不得自动改写语义。

底层通用 Broker 请求基础设施由 Local Runtime CLI 复用，但共享 Provider 合同和 Runtime 路由目标只包含 `local_bridge`、`server_local`。

## 4. Runtime 路由不变量

```ts
type RuntimeExecutionLocation = 'local' | 'server'
```

| 工作区 | 唯一允许的执行位置 |
| --- | --- |
| `local_bridge` | `local` |
| `server_local` | `server` |

位置不匹配时必须 fail closed：

- 本地 Runtime 离线或不支持目标 Runtime 类型时，不得降级到服务器 Runtime。
- 服务器 Runtime 不可用时，不得转发到用户本机。
- Codex、Claude Code 等服务器适配器只声明 `server_local`。
- Local Runtime invocation 必须通过已认证、在线且已注册目标工作区的 CLI 连接执行。

## 5. 本地模式

1. 用户安装并认证 Local Runtime CLI。
2. 用户在 CLI 中授权本机目录，CLI 生成不透明 `workspaceId`。
3. 浏览器从后端获取在线工作区列表并选择一个 `local_bridge` 工作区。
4. 后端发送受约束的 InvocationPlan；CLI 在本机授权目录的隔离执行区启动 Runtime。
5. 变更经相对路径、权限、base hash 和 revision 校验后应用到本机目录。
6. CLI 断线时中断活动 invocation，持久化 `INTERRUPTED`，不自动重放命令或写入。

## 6. 服务器模式

1. 用户在浏览器中明确选择服务器模式并提供服务器路径。
2. 后端验证路径不位于平台仓库、凭据目录或其他拒绝范围。
3. Runtime 在服务器执行；Codex 与 Claude Code 通过独立 Server Runtime Worker 隔离，其他服务器 Runtime 由其服务端 Adapter 执行。
4. Git 仓库任务使用隔离 worktree，并由平台捕获 ChangeSet。
5. Worker 崩溃只能导致 invocation 失败或中断，不得导致 Nest 控制面退出。

## 7. 稳定性与安全

- 业务工作区不得进入平台开发 Watch 范围。
- 稳定运行入口使用编译产物，不依赖 `node --watch`。
- 工作区内读写、测试和命令能力同时受平台授权与执行端本地策略限制。
- 工作区外访问、符号链接逃逸、敏感路径和凭据访问始终拒绝。
- SSE 只是观察通道：瞬时断线快速重连，超过 30 秒后降级为每 30 秒重试，但任何浏览器 SSE 断线都不得中断活动 invocation。
- Local Runtime CLI 的真实传输断开仍以 `runtime_disconnected` 中断对应 invocation；中断后必须由用户显式唤醒，不得自动重复命令、测试或文件变更。

## 8. UI 约定

新建会话只显示两个选项：

- `本地`：选择已由 Local Runtime CLI 注册且在线的工作区；
- `服务器`：输入服务器可访问的绝对路径。

默认选择 `本地`。UI 不显示目录上传、浏览器兼容、浏览器写回或镜像执行入口。

纯讨论、无需文件能力的会话可以不绑定工作目录；这只是“无工作区执行”的受限例外，不是第三种工作区或 Runtime 位置。Web 新建工作区会话仍必须明确选择本地或服务器目录，任何需要文件/命令能力的 Runtime invocation 都不得借此绕过 Provider 绑定。

## 9. 验收标准

- SessionWorkingDirectory 只能是 `local_bridge | server_local`。
- 页面只出现“本地”和“服务器”两个运行位置选择。
- 本地模式的 Runtime 进程和文件访问发生在用户机器。
- 服务器模式的 Runtime 进程和文件访问发生在服务器。
- 任一模式不可用时均明确失败，不跨位置降级。
- 业务文件变化不触发平台后端重启。
- `/workspace-broker` 不再挂载，浏览器镜像和写回服务不再存在。
- 单元测试、类型检查、构建、Harness 和双模式聚合 E2E 通过。

## 10. 后续事项

- 将内部预览 CLI 产品化为签名安装包并建立升级/回滚渠道。
- 扩展 Local Runtime 对 Claude Code、macOS 和 Linux 的正式支持。
- 完成中断会话的显式唤醒 API、幂等状态机和 UI。
