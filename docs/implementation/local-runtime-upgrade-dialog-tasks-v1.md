# Local Runtime 版本升级弹窗与可执行升级 Tasks v1

状态：In progress；协议门禁、统一弹窗、桌面升级编排和浏览器升级唤起已落地，正式发布清单/进度回传仍待发布工程接入。

入口：[Spec](../product/local-runtime-upgrade-dialog-spec-v1.md) | [Plan](../design/local-runtime-upgrade-dialog-plan-v1.md) | [Checklist](../quality/local-runtime-upgrade-dialog-checklist-v1.md)。

任务按约 10–15 分钟一个可独立验收的小步拆分；跨层任务必须先完成 shared 合同。

## 第一批：合同与服务端升级信息

- [x] T1 增加升级合同（AC1–3、AC13）。在 `packages/shared/src/local-runtime-contracts.ts` 增加统一升级信息、进度状态和协议错误合同。
- [~] T2 增加发布清单校验（AC2、AC12）。当前已校验 HTTPS、SHA-256 和签名指纹配置；正式 manifest 版本范围/过期时间校验随发布服务接入。
- [x] T3 扩展兼容性错误（AC1、AC2、AC11）。握手拒绝返回 `upgradeId`、版本、buildId、协议和 release notes。
- [x] T4 修复不兼容连接生命周期（AC11、AC13）。失败握手关闭 socket、清理映射，`connected` 只有 hello 成功才为真。
- [x] T5 增加升级信息接口（AC2、AC8）。增加服务端兼容性和设备授权升级清单接口，并限制 HTTPS 来源。

第一批退出条件：旧协议连接被明确标记为 `incompatible`，新协议连接能拿到完整升级清单，服务端单测通过。

## 第二批：共享状态与 Web 弹窗

- [x] T6 建立升级状态 store（AC3、AC4、AC5、AC13）。实现单调状态、取消、失败和重连超时保护。
- [x] T7 建立共享升级弹窗数据模型（AC1–5）。Web/桌面复用同一 Vue 弹窗，包含无障碍状态播报。
- [x] T8 接入 Web 协议错误（AC1、AC2、AC8）。管理页/全局 AppShell 发现不兼容设备即打开弹窗。
- [~] T9 接入 Browser 升级协议（AC3–10）。已注册 `agent-runtime://upgrade` 并校验 server、upgradeId、nonce；官方发布下载入口需接入正式发行服务。
- [ ] T10 实现 Web 进度订阅和取消（AC3–5、AC13）。订阅升级助手进度，支持下载取消、断线补发和安装阶段不可取消。

## 第三批：Desktop 与 Local Runtime 安装闭环

- [x] T11 接入 Desktop UpdateController（AC1、AC3、AC6）。增加统一 `upgrade()` 编排并复用 `electron-updater` 的下载/安装门禁。
- [x] T12 增加 Desktop 安装前 Runtime 门禁（AC6、AC10）。安装前停止 Runtime，失败不调用 `quitAndInstall`。
- [ ] T13 实现签名 Local Runtime 安装包（AC7、AC8、AC12）。代码已具备校验字段，真实产包/签名/发布仍需发布操作。
- [~] T14 实现 Local Runtime 升级助手（AC3、AC7、AC9、AC10）。已实现 HTTPS 下载、SHA-256、Windows Authenticode、保留 state 并启动安装器；状态回传和回滚编排待补。
- [x] T15 修复开发 supervisor 复用逻辑（AC9、AC11）。锁文件记录协议版本，受管旧协议进程优雅终止后再启动。

## 第四批：可靠性、观测和验收

- [ ] T16 增加结构化升级日志和指标（AC14）。记录 upgradeId、deviceId、版本、阶段、错误码和耗时；禁止记录 Token、完整提示和文件内容。
- [~] T17 增加协议/清单单元测试（AC1–5、AC11–13）。已覆盖协议拒绝、升级 URL、签名配置门禁、桌面编排；正式签名 fixture 和取消/乱序进度仍待补。
- [ ] T18 增加 Browser/CLI 集成测试（AC7–10）。使用隔离签名 fixture 验证协议唤醒、升级失败回滚、状态保留、重新握手和工作区重注册。
- [ ] T19 增加 Desktop E2E 测试（AC1、AC3、AC6、AC10）。验证弹窗、更新下载进度、忙时拒绝安装、重启后重连和失败提示。
- [ ] T20 补发布、运维和回滚文档（AC6–12）。记录正式更新源、签名证书、发布顺序、最低兼容版本、回滚和支持人员操作。
- [ ] T21 执行完整 Checklist 并审查范围（AC1–14）。运行相关测试、typecheck、build 和 Harness 验证；记录跳过项与原因，不把未发布安装包标为通过。

## 依赖与并行关系

```text
T1 -> T2/T3 -> T4/T5 -> T6/T7
T6/T7 -> T8/T9/T10
T1/T2/T5 -> T11/T12/T13/T14
T4/T14 -> T15
T8-T15 -> T16-T21
```

## 实施约束

- 每个任务先固化可观测失败，再实现，再附测试证据。
- 不通过降低服务端协议要求、删除状态文件或关闭安全校验来通过任务。
- 安装器、签名证书和真实发布源属于发布操作；没有用户授权不得上传或发布。
- 真实用户设备升级前必须有回滚包和状态备份策略。
