# 读取授权共享界面开发与验证

日期：2026-10-19。依据 Spec/Plan/Task/Checklist 继续实现 IR05/IR10 的读取授权部分，沿用项目地图、Harness 协议和界面规范。前置为 [授权 API 与源码就绪接入](workspace-authority-report.md)。

## 实现

Web 和 Desktop 的新合同会话聊天区接入同一 `IntentWorkspaceAuthorityPanel`。显示工作区、读取授权状态、刷新、撤销或允许读取动作。离线/导航未就绪时禁用操作；未能确认最新状态时不能发起新的授权变更。旧合同不显示新入口。

共享 Pinia 状态以 sessionId + dataEpoch 隔离请求。请求冻结 bindingHash、grant revision 与幂等键；网络错误/超时保留原请求，切换会话再返回可重试相同操作。409/410 清除冲突请求并刷新，必须由用户再次操作，不自动提升版本提交。待确认请求保留在当前客户端运行期内；浏览器重启后不承诺恢复该内存状态。

API 返回 sessionId/dataEpoch/sessionRevision，客户端运行时校验授权结构与绑定，拒绝其他会话/epoch 和畸形状态。读请求代次和 Session revision 防止迟到 GET 覆盖更新结果。事件流中的授权变化触发刷新；读取请求在切换/卸载时取消，提交结果始终归属于原会话。

使用具名原生按钮、状态/错误播报、可见焦点和可换行布局，不增加额外确认弹窗。重新授权后提示重新发送所需消息，界面没有恢复旧计划或启动任务的副作用。

## 自动检查

- 新组件和状态测试：11 项通过；覆盖断网重试、同请求身份、并发提交、409、旧 GET、跨会话/epoch、禁用与事件刷新。
- Web 全量：91 个文件、481 项测试通过。
- 后端相关回归：168 项通过；真实 HTTP 授权与读取场景 8/8 通过。
- 全仓类型检查及 Shared、Server、Web、Desktop 构建通过。构建存在既有 chunk 大小等警告。
- Harness 与 diff 检查结果见本轮 manifest。本轮未重跑完整后端/Shared/Desktop 单测；前置报告保留原范围。

## 浏览器验证

通过 Playwright CLI 启动共享产品组件 fixture，连接真实隔离 Nest/File 后端和临时工作区；授权接口没有被 mock。两个浏览器页面先持有相同状态，一个撤销，另一页面继续点击旧操作收到 409 并刷新为撤销状态。随后显式重新授权，再用 Tab/Enter 撤销。最终持久化 grant revision 为 4，且只有 revoke/grant/revoke 三条审计事件，冲突请求没有增加事件。

390×844 下文档宽度与视口均为 390，无横向溢出；截图已查看，文本/按钮完整可见。Tab 后按钮焦点 outline 为 solid，Enter 撤销成功。证据为 `workspace-authority-ui-browser-state.json`、`workspace-authority-ui-browser-results.json`、快照、键盘日志，以及 conflict/mobile 截图。

控制台出现 fixture favicon 404 和预期的 HTTP 409；没有把它们报告为产品运行时异常。此测试未运行完整 Web/桌面壳层，也未验证真实 Electron/SSE 网络断连全矩阵。真实 SSE 的 UI 响应由组件事件测试覆盖，不冒充真实双客户端推送验收。

## 证据保留说明

本轮第一次重跑复用了旧 HTTP 脚本的默认 JSON 输出路径，覆盖了 `workspace-authority-http-results.json`。旧 manifest 与原 HTTP 日志保留，但该旧 JSON 的字节 hash 已不再匹配前一 manifest，不能作为前一时点的原始 JSON 校验。当前结果已另存 `workspace-authority-ui-http-results.json`，脚本新增可选输出前缀，后续增量使用独立文件。原有八项场景的日志证据仍在；本轮 manifest 仅对本轮产物负责。

## 未完成

完整受限测试/源码/产物执行器、业务调度、特殊入口统一、实际 Bridge/CLI 读取、真实 GitHub 和 PostgreSQL、执行型纠错及完整故障矩阵仍待推进。58 场景、独立 500+ 双人标注、迁移/发布门不因本轮测试而通过。没有提交或部署。
