# Local Runtime 版本升级弹窗与可执行升级 Checklist v1

状态：In progress；本轮已完成代码级和定向测试验收，真实签名发布与跨进程安装仍未执行。

关联：[Spec](../product/local-runtime-upgrade-dialog-spec-v1.md) | [Plan](../design/local-runtime-upgrade-dialog-plan-v1.md) | [Tasks](../implementation/local-runtime-upgrade-dialog-tasks-v1.md)。

## 1. 验收矩阵

| AC | 任务 | 必须验证 | 结果/证据 |
| --- | --- | --- | --- |
| AC1 | T3、T7、T8、T11 | Web/桌面收到协议不一致时打开同语义升级弹窗 | 部分完成：Web/桌面共享弹窗，需真实桌面协议事件回归 |
| AC2 | T1、T3、T5、T8 | 显示当前版本、目标版本、协议、对象和完整升级内容 | 已完成代码级验证 |
| AC3 | T6、T10、T11、T14 | 检查、下载、校验、安装、重启、重连阶段和真实进度可见 | 部分完成：桌面使用 updater，浏览器当前只回传重连阶段 |
| AC4 | T6、T10 | 检查/下载阶段取消后旧版本继续可用 | [ ] |
| AC5 | T6、T10、T12、T14 | 安装阶段按钮不可误取消，不产生半安装状态 | [ ] |
| AC6 | T11、T12、T20 | Desktop 使用正式 HTTPS 更新源、签名和 `electron-updater` | [ ] |
| AC7 | T9、T13、T14 | Browser 通过 `agent-runtime://upgrade` 完成本地升级 | [ ] |
| AC8 | T5、T9、T13 | 未安装 Runtime 时可取得官方签名安装包 | [ ] |
| AC9 | T14、T15、T18 | 升级后完成新握手并重新注册全部工作区 | [ ] |
| AC10 | T12、T14、T18、T19 | 失败/中断后保留旧版本、Token、设备和工作区 | [ ] |
| AC11 | T4、T15、T17 | 不兼容 socket 不再显示 connected/ready | 已完成：服务端集成测试通过 |
| AC12 | T2、T13、T17 | SHA-256、签名、来源校验失败时禁止安装 | 部分完成：CLI 已拒绝缺失/错误校验，真实签名 fixture 待补 |
| AC13 | T6、T10、T18 | 刷新、断线、乱序后进度单调，不回退 | 部分完成：store 单调状态已测试范围内验证 |
| AC14 | T16、T20、T21 | 日志和指标可关联升级全过程且无敏感信息 | 部分完成：握手日志含 upgradeId/版本，完整指标待发布服务接入 |

## 2. 必测场景

### 协议和版本

- [ ] Client protocol 7 / Server protocol 11：弹窗显示 `7 → 11`，设备状态为 `incompatible`。
- [ ] Client protocol 11 / Server protocol 11：不显示升级弹窗，完成正常握手。
- [ ] Client buildId 过旧但协议可兼容：显示客户端升级内容。
- [ ] Server 版本低于客户端：显示“服务端需要升级”，不要求客户端盲目降级。
- [ ] 旧连接 socket 保持 OPEN：API 仍返回 `connected=false`。

### 弹窗交互

- [ ] Title 精确为“版本升级”。
- [ ] 当前版本、目标版本、升级对象和升级内容完整展示。
- [ ] 升级内容过长时可滚动，不遮挡底部按钮。
- [ ] “取消升级”和“立即升级”键盘可达，有可关联的 aria-label。
- [ ] 下载阶段取消可重复操作且不会重复创建升级任务。
- [ ] 安装阶段取消按钮置灰并解释原因。
- [ ] 升级失败显示错误原因、重试和人工安装入口。

### 浏览器端

- [ ] 已安装旧 Runtime：`agent-runtime://upgrade` 被唤醒，nonce 和 server origin 校验通过。
- [ ] 未安装 Runtime：显示官方签名安装包下载入口。
- [ ] 下载、校验、停止、安装、重启、重连状态可回传。
- [ ] 浏览器刷新后按 `upgradeId` 恢复最新状态。
- [ ] 助手断线后不会把“安装中”误判为“升级完成”。

### 桌面端

- [ ] `electron-updater` 检查、下载、安装状态映射到统一弹窗。
- [ ] 正式包使用签名发布者验证；未配置更新源的开发包明确提示不可在线升级。
- [ ] Runtime 忙时安装被阻止并显示原因。
- [ ] 安装失败不调用 `quitAndInstall`，旧版本仍能启动。
- [ ] 重启后新 Runtime 完成握手并恢复工作区。

### 安全和数据保留

- [ ] 非 HTTPS、错误签名、SHA-256 不匹配、过期 manifest 均拒绝安装。
- [ ] 安装地址不能由客户端错误字符串覆盖。
- [ ] `state.json`、Token、deviceId、workspaceId、权限和任务记录升级前后保持一致。
- [ ] 日志不含 Token、refresh token、完整提示、文件内容和未脱敏路径。
- [ ] 非幂等任务不因升级自动重复执行。

## 3. 最小验证命令

```powershell
npm run typecheck
npm run test -w @agent-cluster/shared
npm run test -w @agent-cluster/local-runtime-cli
npm run test -w @agent-cluster/server
npm run test -w @project/web
npm run test:desktop
node --test scripts/dev-local-runtime.spec.mjs scripts/dev-local-runtime-reconnect.spec.mjs scripts/dev-all.spec.mjs
npm run build
npm run test:harness
```

需要新增并执行的定向入口：

```powershell
node --test apps/server/src/modules/local-runtime/upgrade-contract.spec.ts
node --test tests/e2e/local-runtime-upgrade-dialog-smoke.mjs
node --test tests/e2e/local-runtime-upgrade-recovery-smoke.mjs
```

真实签名发布、上传更新源和真实用户设备安装属于发布操作，必须单独取得授权；未授权时只能使用隔离 fixture，不得宣称正式升级已验收。

## 3.1 本轮代码级证据

- `npm run typecheck -w @agent-cluster/shared`
- `npm run typecheck -w @agent-cluster/server`
- `npm run typecheck -w @project/web`
- `npm run typecheck -w @agent-cluster/local-runtime-cli`
- `npm run typecheck -w @agent-cluster/desktop`
- `npm run test -w @agent-cluster/server`：1804 tests，0 failed。
- `npm run test -w @agent-cluster/local-runtime-cli`：95 tests，0 failed。
- `npm run test -w @project/web`：367 tests，0 failed。
- `npm run test:desktop`：14 tests，0 failed。
- shared/server/local-runtime-cli/web/desktop build 均通过；Vite 仅报告既有 chunk size warning。
- Harness Phase 1/2/3 均通过。

以上证据不等同于真实 Windows 签名发行包、升级回滚和跨设备安装验收；这些仍保留为发布任务。

## 4. 发布前检查

- [ ] Desktop、Server、Local Runtime 的版本和 buildId 来源一致。
- [ ] Server 的 `minSupportedVersion` 未早于可回滚客户端。
- [ ] Windows 安装包已签名，签名发布者与配置一致。
- [ ] release manifest、`latest.yml`、blockmap、SHA-256 齐全。
- [ ] 先上传安装包，再发布 manifest。
- [ ] 升级失败、断网、取消、安装中止和回滚均有演练证据。
- [ ] 监控升级失败率、重连成功率、工作区重新注册数量和协议不兼容数量。

## 5. 证据记录模板

| 项目 | 记录 |
| --- | --- |
| 代码版本 | commit、工作区差异、shared/server/desktop/runtime buildId |
| 测试环境 | Windows 版本、浏览器/桌面版本、隔离 server 地址 |
| 版本迁移 | fromVersion、toVersion、fromProtocol、toProtocol |
| 升级包 | releaseId、签名发布者、SHA-256、大小 |
| 进度证据 | 各阶段时间、percent、upgradeId |
| 数据保留 | state、Token、设备 ID、工作区数量前后对比 |
| 失败演练 | 故障点、错误码、旧版本是否可用、回滚结果 |
| 限制 | 跳过项、跳过原因、是否使用隔离 fixture |

## 6. 完成条件

- [ ] AC1–AC14 均有实际证据。
- [ ] Browser 和 Desktop 两条升级路径均通过。
- [ ] 无签名包、无可信发布源或仅有错误提示时，不得标记升级功能完成。
- [ ] 旧 Runtime 不再被错误显示为在线。
- [ ] 失败和回滚验证通过后，才允许提升服务端最低兼容协议版本。
