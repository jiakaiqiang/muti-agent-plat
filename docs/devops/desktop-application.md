# Agent Cluster 桌面应用

这是原 Codex 式工作区的 Windows 桌面交付，需求、设计和验收仍由 [Spec](../product/codex-style-multi-agent-workspace-spec-v1.md)、[Plan](../design/codex-style-multi-agent-workspace-plan-v1.md)、[Tasks](../implementation/codex-style-multi-agent-workspace-tasks-v1.md)、[Checklist](../quality/codex-style-multi-agent-workspace-checklist-v1.md) 管理。

## Web 与桌面分别使用

Web 使用原浏览器地址及 `apps/web` 构建，保留主导航、会话头像和深色流程视图。桌面使用 `apps/desktop/renderer` 独立构建，提供 Codex 式三栏、无图标任务记录和只读流程目录。两端连接同一平台数据，工作区布局和样式分别维护。

修改 Web 页面后重新部署 Web；修改桌面页面后重新构建并生成桌面安装包，已安装用户通过应用升级获得新页面。流程内容从平台刷新，已开始的运行仍固定原版本；它不要求重新安装客户端。

## 安装使用

本地构建的安装包位于 `output/desktop/Agent-Cluster-Setup-0.1.0-x64.exe`。安装后从快捷方式打开 Agent Cluster，首次进入“连接与更新”。

1. 输入平台地址，点击“连接并保存”。远程使用 HTTPS；本地开发可以填写 `http://127.0.0.1:8099`，需要平台后端已经运行。客户端不启动 Nest、数据库或开发服务器。
2. 点击“启动本地助手”。首次显示设备码，点击“授权此设备”，用平台管理员提供的本地运行管理凭据完成授权。现有平台仍是设备码/管理员凭据模型，本次没有新增完整多用户登录体系。
3. 在“本地运行”中检测 Agent、授权本机目录；外部 Codex/Claude 工具及其账号需要用户自己的环境配置。客户端与内置助手本身不要求另装 Node/npm。
4. 进入工作台，澄清并确认需求，然后从流程目录选择已发布流程。任务、返工、历史、Agent 详情和 Diff 沿用已有工作区。

通过“应用 → 连接与更新”再次打开设置。桌面工作台左侧仅展示新建任务、分类与任务记录，不再常驻管理、流程目录及搜索区域；在群聊选流程确认卡中点击“管理工作流”可打开只读流程目录。桌面不能进入 Web 流程维护页，流程目录仍只查看和使用。共享平台仍必须启用服务端作者权限策略；桌面拦截不替代后端鉴权。

关闭窗口会隐藏到托盘，助手继续工作；双击托盘图标或再次启动应用可恢复。使用“应用 → 退出应用”或 `Ctrl+Q` 真正退出。助手仍在执行 invocation、文件操作或授权请求时会拒绝停止，不强杀。已断开的任务保持既有中断恢复语义，不自动重放。保护范围是助手已接收的本地操作；不承诺主动退出后远端排队任务仍能继续在离线本机执行。

## 任务完成消息通知

默认开启原生系统通知，在“应用 → 连接与更新 → 消息通知”关闭或发送测试通知。应用运行期间每 5 秒检查完成事件，窗口最小化、切换会话或隐藏到托盘仍可提醒；点击恢复窗口并打开对应会话。不会补弹启动前的历史完成任务，不把单个 Agent 完成、失败或取消提示为成功。完全退出后不继续推送。

通知开关独立保存在 userData/notifications.json，开发启动不覆盖。Windows 位置、持续时间、声音及勿扰策略由系统控制；未看到横幅时检查系统设置中的应用通知权限和勿扰模式。实现使用 [Electron 原生 Notification](https://www.electronjs.org/docs/latest/api/notification)，没有自绘常驻顶层窗口。

修改通知主进程代码后须安全退出并重新打开桌面，浏览器刷新不能加载该改动。验证入口为 `npm run test:desktop` 和 `npm run test:e2e:desktop-notifications`，后者使用独立测试平台与临时配置，不运行用户任务。

## 开发与生成安装包

同时启动后端、Web 与桌面窗口，在仓库根目录执行：

```powershell
npm run dev
```

命令先编译最新桌面资源，再启动后端和 Web；后端健康检查通过后自动打开桌面工作台，连接 `http://127.0.0.1:8099`（跟随 `.env` 的 `SERVER_PORT`）。浏览器访问 `http://127.0.0.1:8089`（跟随 `WEB_PORT`）。无需安装 exe 或在桌面手动填写平台地址。

开发桌面的配置、设备凭据和日志位于 `.cache/agent-cluster/desktop-dev-<后端端口>/`，与已安装客户端分开。同一端口重复启动复用已有桌面窗口。统一启动入口在后端就绪后自动连接已有独立 Local Runtime，保留设备身份、工作目录绑定；不启动桌面内置助手、不复制凭据或新增目录授权。已授权的本机开发环境中，令牌缺失/失效会恢复原 active 设备的凭据，进程退出后启动器每 30 秒检查并重新拉起；未知或已撤销设备不会自动授权。详见 [本地开发说明](./local-development.md)。终端 `Ctrl+C` 停止 Web/后端，桌面与独立 Runtime 保留；后端恢复后 Runtime 自行重连。桌面通过“应用 → 退出应用”安全退出，该操作不停止独立 Runtime。执行中的任务仍按原中断恢复规则处理。

`npm run dev:all` 是 `npm run dev` 的别名。启动器会等待桌面确认窗口可见且连接正确；仅创建 Electron 进程不算启动成功。超时或失败时查看上述开发配置目录内的 `desktop.log`。

当前桌面仍是构建后预览，不是热更新：改桌面代码后先安全退出桌面，再重新执行 `npm run dev`；只改 Web 页面继续使用 Vite 热更新。仅启动 Web/后端使用 `npm run dev:web`，仅编译并打开桌面保留 `npm run desktop:dev`。

桌面构建工具需要 Node **22.12 或以上**（本次 Windows 打包使用 Node 24.19.0），npm workspace 从仓库根目录安装。原后端可继续使用自身支持的 Node 版本。最终用户无需安装这些构建工具。

```powershell
npm install
npm run desktop:dev
```

`desktop:dev` 会编译生产资源并启动 Electron，不启动 Vite，也不启动平台后端。源码改动后重新运行以更新资源。

```powershell
npm run desktop:pack
```

生成 NSIS 安装包和 `output/desktop/win-unpacked/Agent Cluster.exe`。后者可以直接运行以验证打包资源；不能把运行解包程序的测试称为已经验证了 NSIS 安装/卸载。安装包只包含桌面资源、更新依赖和打包后的助手，不包含仓库源代码或后端数据库。

首次构建需要下载 Electron 和 NSIS 工具。打包复用当前 workspace 安装的 Electron 二进制。若 GitHub 下载不可达，可在当前终端设置 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/` 后重试；保留 electron-builder 的校验和检查，不关闭校验或替换校验值。

## 数据位置与平台隔离

默认使用 Electron 的用户数据目录（Windows 通常为 `%APPDATA%/Agent Cluster`），不是安装目录：

- `desktop-config.json`：所选平台 origin。
- `platforms/<origin hash>/runtime/`：设备凭据、授权目录、索引及本地凭据文件；复用现有 Local Runtime 存储方式，不复用独立 CLI 的默认状态文件。
- Chromium `persist:platform-<origin hash>` partition：每个平台独立页面存储。切平台不会带走上一平台的凭据和页面状态。

设备 token 沿用 helper 的本地 state 文件持久化方式；不能将它宣传为本次已新增 OS 加密保管。Provider API key 沿用现有 LocalSecretStore 的 Windows DPAPI。卸载配置为不主动删除用户数据；干净机器升级/卸载保留验收仍需单独执行。

测试可通过标准 `--user-data-dir=<绝对路径>` 使用独立 profile。测试脚本使用临时目录，避免改写用户的真实连接配置和授权。

## 更新与正式发布

默认本地安装包没有启用正式更新源。它可用于本地验证，不能宣称正式签名发行或在线升级已经验收。

正式构建需要发布方准备以下配置：

| 配置 | 用途 |
| --- | --- |
| `AGENT_CLUSTER_UPDATE_URL` | 托管 Windows 更新文件的 HTTPS 目录 |
| `AGENT_CLUSTER_PUBLISHER_NAME` | 签名证书对应的发布者名称 |
| `CSC_LINK` 或 `WIN_CSC_LINK` | 签名证书位置，按 electron-builder 支持方式提供 |
| `CSC_KEY_PASSWORD` 或 `WIN_CSC_KEY_PASSWORD` | 若证书需要，提供密码；不要提交到仓库 |

```powershell
npm run desktop:pack:release
```

此命令只构建，不上传或部署。缺少发布地址、发布者或证书时拒绝正式打包；`forceCodeSigning` 要求真正签名成功。仅正式包写入启用更新的发布元数据，普通包即使构建环境存在更新 URL 也不启用自动更新。

新增客户端功能时修改 `apps/desktop/package.json` 的应用版本并重新构建；如果助手自身协议/版本变更，还需更新其 package 版本及后端兼容范围，助手版本由构建注入，不硬编码另一份版本。发布经验证的安装包、blockmap 和 `latest.yml` 到配置的同一更新目录；先上传文件，最后公布版本元数据。上传行为需另行授权。

用户在“连接与更新”检查、下载、点击重启安装。关闭 `autoDownload`、`autoInstallOnAppQuit`、降级更新；下载完成不会自行重启。安装前等待本地助手空闲停止握手，失败或超时不启动安装器。更新校验沿用 electron-updater 的签名发布者验证，不覆盖任意 feed。

流程图发布属于平台数据刷新，不要求更新客户端；已有运行仍使用原版本快照。后端变更须兼容正在使用的客户端 API/协议。本次不实现完整离线后端、不承诺自动版本回滚。

## 验证

```powershell
npm run test:desktop
npm run desktop:build
npm run test:e2e:desktop-render
npm run test:e2e:desktop
```

`test:e2e:desktop` 启动真实 Electron、隔离 HTTP/WebSocket 测试平台和确定性本地进程，验证内置 UI、IPC、API/SSE、流程只读、设备码、助手、忙时拒绝停止、ChangeSet 写回、关窗保留、平台隔离和重启恢复。这不是生产后端/真实模型验收；测试目录预授权，不冒称点击过原生目录选择窗口。

`test:e2e:desktop-render` 在独立临时 profile 中加载当前桌面构建，验证真实 `agent-cluster://` 协议和 CSP 下的连接页、工作台、刷新、沙箱及无脚本错误。只连接隔离只读 API，不授权助手或执行任务；修改共享模块/桌面入口后必须先构建再运行此项。HTTP 页面预览不带同一 CSP，不能替代该验证；启动器的“窗口可见”回执也不等于 Vue 已渲染。截图位于 `output/playwright/desktop-render/`。

验证打包后的程序：先 `npm run desktop:pack`，设置 `AGENT_CLUSTER_DESKTOP_EXECUTABLE` 为 `output/desktop/win-unpacked/Agent Cluster.exe` 的绝对路径，再执行同一冒烟命令。截图在 `output/playwright/desktop/`；当前实际结果及全仓库检查限制见 Checklist。

参考：[Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)、[Electron protocol](https://www.electronjs.org/docs/latest/api/protocol)、[electron-builder 更新](https://www.electron.build/docs/features/auto-update/)。
