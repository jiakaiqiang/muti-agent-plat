# Local Runtime 版本升级弹窗与可执行升级 Plan v1

状态：In progress；协议门禁、弹窗、桌面编排、浏览器唤起和开发 supervisor 已实现。

关联：[Spec](../product/local-runtime-upgrade-dialog-spec-v1.md) | [Tasks](../implementation/local-runtime-upgrade-dialog-tasks-v1.md) | [Checklist](../quality/local-runtime-upgrade-dialog-checklist-v1.md)。

## 1. 设计决策

### 1.1 方案选择

选择“共享合同 + 共享状态模型 + 双端升级适配器”。

- Web 和 Desktop 共用升级弹窗的数据合同、状态枚举、文案和验收规则。
- Desktop 适配器调用已有 `electron-updater`。
- Browser 适配器调用签名安装包和 `agent-runtime://upgrade` 本地助手。
- Server 负责兼容性判断、发布清单和权限校验，但不直接执行客户端安装。

不选择仅返回下载链接：它无法保证浏览器端安装、进度回传、签名校验和升级后的重连闭环。不选择服务端强制降级协议：会掩盖真实合同不兼容并产生数据损坏风险。

## 2. 现状映射

允许变更的主要区域：

- `packages/shared/src/local-runtime-contracts.ts`：协议、升级和进度合同。
- `apps/server/src/modules/local-runtime/`：握手、设备状态、升级清单和进度代理。
- `apps/web/src/stores/localRuntime.ts`：兼容性与升级状态。
- `apps/web/src/views/LocalRuntimeManagerView.vue` 及共享弹窗组件：Web 交互。
- `apps/desktop/src/update-controller.ts`、`apps/desktop/src/preload.ts`、桌面渲染页面：Desktop 交互。
- `packages/local-runtime-cli/`：升级助手、签名包校验和状态上报。
- `scripts/dev-local-runtime.mjs`：开发环境协议/buildId 不一致时重启受管 Runtime。

禁止顺带修改：Agent 编排、会话业务状态、工作区授权语义、模型选择和无关页面样式。

## 3. 服务端合同和数据流

新增或扩展只读接口：

```text
GET /api/local-runtime/compatibility
GET /api/local-runtime/upgrades/:upgradeId
GET /api/local-runtime/upgrades/:upgradeId/progress
```

握手失败返回：

```text
LOCAL_RUNTIME_PROTOCOL_INCOMPATIBLE
  -> fromVersion / toVersion
  -> fromBuildId / toBuildId
  -> upgradeId
  -> releaseNotes
  -> mandatory
```

Server 仅返回配置中的受信任发布清单，不接受客户端提交任意安装地址。升级包元数据由发布流程写入，包含版本、协议、buildId、SHA-256、签名、安装包大小、发布时间和变更说明。

## 4. 状态模型

共享升级状态：

```text
idle
checking
available
downloading
verifying
stopping
installing
restarting
reconnecting
completed
cancelled
failed
```

状态转换必须单调，除非进入 `failed` 后用户显式重试。进度状态至少带 `upgradeId`、`updatedAt` 和可选 `percent`。前端收到旧时间戳或旧阶段事件时忽略，防止刷新/SSE 乱序回退。

## 5. Desktop 适配器

复用 `apps/desktop/src/update-controller.ts`：

- 映射 `checking-for-update` 到 `checking`。
- 映射 `update-available` 到 `available`。
- 映射 `download-progress` 到 `downloading`。
- 映射 `update-downloaded` 到 `installing` 前置状态。
- 安装前调用现有 Runtime stop 门禁。
- `quitAndInstall` 后由启动流程重新握手。

更新源只允许正式构建注入的 HTTPS 地址和签名发布者。开发包显示“未配置正式更新源”，不得伪装成可在线升级。

## 6. Browser/Local Runtime 适配器

新增受信任的 `agent-runtime://upgrade` 命令，参数只允许：

- `serverOrigin`。
- `upgradeId`。
- 一次性随机 nonce。

CLI 根据 `upgradeId` 从服务端获取清单，不接受 URL 参数覆盖清单。升级助手执行：

1. 下载到临时目录。
2. 校验 HTTPS、SHA-256 和签名发布者。
3. 通知服务端进入 `stopping`。
4. 等待当前任务达到可安全停止点。
5. 安装新版本。
6. 保留并迁移 `state.json`。
7. 启动新 Runtime。
8. 发送新协议 `hello`。
9. 工作区全部重新注册。
10. 上报 `completed`。

安装器必须支持旧版本保留或失败回滚；升级助手不能直接覆盖正在运行的二进制文件。

## 7. 进程监督与开发环境

`scripts/dev-local-runtime.mjs` 的复用条件增加：

- server origin 相同。
- 当前协议范围兼容。
- buildId 相同。
- 启动参数相同。
- lock 所属进程确实由当前 supervisor 管理。

若受管 Runtime 版本不匹配，优雅停止后重新启动；若是用户手工启动的外部进程，只标记 `incompatible` 并提示升级，不强制杀进程。

## 8. 失败、取消和恢复

- 网络错误：允许有限指数退避重试。
- 协议不兼容：不自动重试，等待用户升级。
- 下载取消：删除临时文件，状态为 `cancelled`。
- 签名校验失败：状态为 `failed`，禁止安装。
- 安装失败：保留旧版本，记录失败原因。
- 重启后未握手：保持 `reconnecting`，超时后转 `failed`，不伪称成功。
- 状态上报断线：升级助手本地保留状态，恢复连接后按 `upgradeId` 补发最新状态。

升级不自动恢复非幂等任务；任务沿用既有恢复/人工确认流程。

## 9. 发布与回滚

发布顺序：

1. 构建 shared、server、desktop、Local Runtime。
2. 生成唯一 buildId。
3. 生成并签名 Windows 安装包。
4. 生成 `latest.yml`、blockmap、SHA-256 和 release manifest。
5. 执行签名、协议、安装、回滚测试。
6. 先上传安装包，最后发布元数据。
7. 服务端再提升 `minSupportedVersion`。

回滚顺序：

1. 停止提升最低兼容版本。
2. 保留已下载安装包和升级日志。
3. 让旧客户端继续连接仍兼容的服务端窗口。
4. 不删除状态文件和升级记录。
5. 通过签名的上一版本安装包恢复，不使用协议降级伪造成功。

## 10. 风险

| 风险 | 控制措施 |
| --- | --- |
| 浏览器无法直接安装 | 使用 `agent-runtime://upgrade` 和本地升级助手 |
| 安装包被篡改 | HTTPS、签名发布者和 SHA-256 三重校验 |
| 升级中断导致 Runtime 不可用 | 临时目录、旧版本保留、失败回滚 |
| 升级后工作区丢失 | 保留 `state.json`，升级后重新注册并验证数量 |
| 进度回退 | `upgradeId + updatedAt + 单调阶段` 收敛 |
| 开发进程陈旧 | supervisor 校验协议和 buildId 后再复用 |
| 用户误以为桌面/CLI 都能自动升级 | 弹窗明确升级对象和安装来源 |
