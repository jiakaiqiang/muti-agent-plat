# Local Runtime 版本升级弹窗与可执行升级 Spec v1

状态：Implemented first slice；正式签名发行和跨进程进度回传仍按发布任务推进。

关联：[Plan](../design/local-runtime-upgrade-dialog-plan-v1.md) | [Tasks](../implementation/local-runtime-upgrade-dialog-tasks-v1.md) | [Checklist](../quality/local-runtime-upgrade-dialog-checklist-v1.md)。

## 1. 目标

当浏览器端、桌面端或 Local Runtime 检测到前后端协议/构建版本不一致时，向用户展示统一的“版本升级”弹窗，并提供可执行、可观察、可取消或可恢复的升级流程。

本 Spec 解决“提示版本过低但用户不知道如何升级”的闭环问题：升级来源可信、版本信息明确、升级内容可读、进度可见、升级失败可恢复，且不丢失设备凭据、工作区和任务状态。

本功能同时覆盖：

- Web 浏览器工作台。
- Electron 桌面端。
- Windows 独立 Local Runtime CLI/助手。
- Server 与 Local Runtime 的协议握手及升级元数据。

## 2. 当前证据与问题边界

| 编号 | 事实 | 影响 |
| --- | --- | --- |
| E1 | `packages/shared/src/local-runtime-contracts.ts` 当前协议为 11，旧 Runtime 仍可能发送 7 | 必须在握手阶段返回结构化升级信息，不能只返回字符串错误 |
| E2 | Server 当前会拒绝不兼容协议，但旧连接可能仍保持 socket open | “在线”状态必须以握手成功为准，失败连接不能触发升级后继续接单 |
| E3 | 桌面端已有 `electron-updater`、下载和重启安装控制器 | 桌面端可以复用现有更新能力，但需接入统一升级弹窗 |
| E4 | Local Runtime CLI 当前是 workspace 内部预览包，尚无面向普通用户的签名安装包和自动升级入口 | Web 端必须补充签名安装包、`agent-runtime://upgrade` 和本地升级助手 |
| E5 | 开发 supervisor 会复用独立 Runtime 进程 | 协议或 buildId 不一致时不能仅依据进程存活复用旧进程 |

## 3. 范围

### 3.1 必须实现

1. 统一的协议不兼容检测事件。
2. 统一的升级信息合同和版本展示。
3. Web 与桌面端一致的升级弹窗视觉和交互语义。
4. 当前版本、目标版本、升级对象和升级内容展示。
5. 下载、校验、停止、安装、重启、重连等进度展示。
6. “取消升级”和“立即升级”两个操作。
7. 桌面端使用 `electron-updater` 完成升级。
8. 浏览器端通过签名安装包和 `agent-runtime://upgrade` 启动本地升级助手。
9. 升级完成后的协议重新握手和工作区重新注册。
10. 升级失败时保留旧版本、旧状态和可重试入口。

### 3.2 不在本期范围

- 浏览器直接修改本机程序文件。
- 未签名或来源不受信任的安装包。
- 自动降级协议或静默绕过协议检查。
- 自动重放升级前未完成的非幂等模型任务。
- 删除用户状态文件、设备凭据或工作区绑定来“解决”版本不一致。
- macOS、Linux 和企业软件分发策略；本期以 Windows 为第一交付目标。

## 4. 用户体验要求

### 4.1 弹窗内容

标题固定为：`版本升级`。

内容区必须展示：

- 当前版本，例如 `v0.1.0`。
- 目标版本，例如 `v0.2.0`。
- 当前协议与目标协议，例如 `Protocol 7 → Protocol 11`。
- 升级对象：桌面应用、Local Runtime 或服务端。
- 升级内容列表。
- 安装包大小和预计影响。
- 是否必须升级。
- “升级后会保留设备授权和工作区绑定”的提示。

升级内容来自服务端签名发布清单，不从异常字符串中拼接，不允许执行远程 HTML。

### 4.2 底部进度

底部固定展示状态和进度：

```text
检查升级包
下载中 45%
校验安装包
停止旧 Runtime
安装新版本
重新启动 Runtime
重新连接服务端
升级完成
```

安装阶段可以没有百分比，但必须展示当前阶段；百分比不得伪造。

### 4.3 操作按钮

- `取消升级`：检查和下载阶段可取消；取消后旧版本继续可用。
- `立即升级`：开始检查、下载并执行升级。

安装已开始后不能安全取消时，`取消升级` 置灰并显示“安装中不可取消”。升级完成前不得删除旧版本或本地状态。

## 5. 统一合同

建议在 `packages/shared` 增加以下合同：

```ts
interface RuntimeUpgradeInfo {
  upgradeId: string
  subject: 'desktop' | 'local-runtime' | 'server'
  fromVersion: string
  toVersion: string
  fromProtocolVersion?: number
  toProtocolVersion?: number
  fromBuildId?: string
  toBuildId: string
  releaseNotes: string[]
  packageSize?: number
  sha256: string
  signature: string
  installerType: 'windows-nsis' | 'manual-package'
  mandatory: boolean
  releaseUrl: string
}

interface RuntimeUpgradeProgress {
  upgradeId: string
  state: 'checking' | 'available' | 'downloading' | 'verifying' | 'stopping'
    | 'installing' | 'restarting' | 'reconnecting' | 'completed' | 'cancelled' | 'failed'
  percent?: number
  message?: string
  errorCode?: string
}
```

协议错误必须携带 `upgradeInfo` 或可通过授权接口查询到对应的 `upgradeId`。

## 6. 双端升级路径

### 6.1 桌面端

1. 收到协议不兼容事件。
2. 打开统一升级弹窗。
3. 调用桌面端 `check`、`download`、`install` IPC。
4. `UpdateController` 推送下载进度。
5. 安装前等待本地助手空闲并停止握手。
6. `quitAndInstall` 重启桌面端。
7. 启动本地助手并完成握手。
8. 重新注册工作区后关闭弹窗。

### 6.2 浏览器端

1. 收到协议不兼容事件。
2. 打开同一套升级弹窗。
3. 点击“立即升级”后调用受信任的 `agent-runtime://upgrade`。
4. 本地升级助手下载、校验并安装签名安装包。
5. 助手通过 loopback 状态接口或 WebSocket 上报进度。
6. 旧 Runtime 停止，新 Runtime 启动并重新握手。
7. 浏览器以 `upgradeId` 订阅状态，收到 `completed` 后刷新设备和工作区。

未安装 Local Runtime 时，弹窗必须显示“下载并安装 Local Runtime”，并提供官方安装包入口；不能显示一个无法执行的浏览器安装按钮。

## 7. 必须保持的不变量

- I1：协议不兼容的客户端不能显示为 `ready/connected`。
- I2：升级包必须校验 HTTPS 来源、签名和 SHA-256；校验失败不得安装。
- I3：升级过程不删除设备 ID、Token、工作区、权限和任务记录。
- I4：安装失败保留旧版本，旧版本不能被标记为已升级。
- I5：升级前后的 `upgradeId`、设备 ID 和工作区 ID 可关联。
- I6：协议不兼容时不自动降级、不静默忽略、不无限重试。
- I7：非幂等任务不会因为升级自动重复执行。
- I8：升级完成必须以新的握手成功和工作区重新注册为准，而不是以安装器退出为准。

## 8. 验收条件

| 编号 | 验收要求 |
| --- | --- |
| AC1 | Web 和桌面端在协议/构建不一致时都打开“版本升级”弹窗 |
| AC2 | 弹窗显示当前版本、目标版本、协议版本、升级对象和完整升级内容 |
| AC3 | 弹窗底部显示真实的检查、下载、校验、安装、重启、重连进度 |
| AC4 | 点击“取消升级”可取消检查/下载，旧版本仍可用 |
| AC5 | 安装阶段取消按钮按安全规则置灰，不造成半安装状态 |
| AC6 | 桌面端使用签名更新源和 `electron-updater` 完成安装 |
| AC7 | 浏览器端通过 `agent-runtime://upgrade` 启动本地升级助手 |
| AC8 | 未安装 Runtime 时，用户能获得官方签名安装包入口 |
| AC9 | 升级成功后新 Runtime 完成握手并重新注册所有工作区 |
| AC10 | 升级失败保留旧版本、Token、设备 ID 和工作区绑定 |
| AC11 | 协议错误不会把旧 Runtime 显示为在线 |
| AC12 | 下载包签名或 SHA-256 校验失败时禁止安装并给出可读错误 |
| AC13 | 升级状态刷新、断线、重连后不会回退到旧进度 |
| AC14 | 升级过程和结果有可关联的结构化日志，不记录凭据和文件内容 |
