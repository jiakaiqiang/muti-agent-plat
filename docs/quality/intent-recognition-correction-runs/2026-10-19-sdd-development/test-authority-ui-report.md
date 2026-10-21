# 隔离测试授权共享界面开发记录

日期：2026-10-19。继续依据四份 SDD 文档推进 IR05/IR10，完成测试授权界面的一个切片，未完成整个意图识别改造。

## 改动

Web 与 Desktop 的 SessionWorkspace 接入同一个 IntentTestAuthorityPanel 和 Pinia Store。新合同会话显示脚本选择、授权状态、刷新、允许所选测试及撤销操作；旧授权失效或 runner 配置消失时仍可撤销。选择脚本使用有标签的原生 select，按钮具备键盘焦点，状态和错误分别使用 status/alert。界面明确提示自动测试执行暂未开放，授权不会启动测试。

请求冻结 sessionId/dataEpoch、script、bindingHash、expectedGrantRevision 和幂等键。网络中断、408/429/5xx 保留原请求，用户只能明确重试原操作；409/410 清除待请求并刷新，等待用户核对后再次操作，不自动换版本重发。GET 与 POST 有读取序号、会话身份和 Session revision 保护，跨会话迟到结果不能覆盖当前界面。离线或状态未知时禁止新授权。

未确认请求保存在当前标签页 sessionStorage；刷新页面和重新挂载 Store 后可以恢复原身份，但不会自动提交。恢复时验证会话、epoch、脚本、hash、版本及字段清单，拒绝跨会话和注入命令的存储内容。关闭标签页、清理存储或浏览器不支持 sessionStorage 时不保证恢复；当前运行期仍可重试。这个机制没有修改既有读取授权 Store。

## 实际验证

新增 7 项 Store 测试和 5 项组件测试最终全部通过。覆盖脚本与请求冻结、刷新后的恢复、幂等请求清除、冲突后新操作、配置失效时撤销、迟到 GET、并发提交、错误合同/外来 epoch、存储损坏、503 和离线状态。首次运行遗漏了 Vitest 显式清单中的 Store 文件，实际只执行 5 项组件测试；发现后加入清单并重新执行，最终相关 12 项、Web 全量 493 项通过。此前 5 项/486 项日志以 incomplete 后缀保留，不计为完整覆盖。

真实 Chromium 浏览器运行共享产品组件，代理到隔离 Nest API 与临时工作区。两个标签页实际验证 TU01–TU08：选择 test:unit 授权；另一页提交陈旧选择返回 409 并刷新；撤销与另一页刷新；服务端已提交但通过 Playwright 中断响应后显示结果未知；刷新页面仍保留 test:integration 原请求；点击重试获得 idempotentReplay=true，两个 POST 内容完全相同；390px 无横向溢出；Tab/Enter 完成撤销。已人工查看移动和桌面截图，文本与控件未遮挡或溢出。

浏览器结束时 File 中仅有 4 条有效授权事件，版本依次为 1→2→3→4，最终撤销；未知响应后的重试没有新增授权效果，test_runner 调用数为 0。浏览器只有 fixture favicon 的 404，授权冲突和主动中断是预期故障注入。此为真实共享组件+API验证，不是完整 Web 应用导航、Electron 进程或真实 SSE 传输验收；SSE 事件触发刷新由组件测试覆盖。

全仓类型检查、Web/Desktop 构建、Harness 和 diff 检查通过。构建保留现有大 chunk 提示，未为本切片修改打包策略。后端产品代码未改，本轮未重跑全后端、Docker 或 PostgreSQL；真实 API 已在浏览器场景执行。命令、日志、截图、状态及源码 hash 见 test-authority-ui-manifest.json。

## 剩余工作

版本化测试计划派发、实际 runner 资源传递、运行中撤销、结果/报告提交和执行型纠错仍待完成；UI 中的“自动测试执行暂未开放”必须随真实执行能力一起更新。完整双客户端、CLI/Bridge、数据库、全场景、独立人工评测与发布门仍未通过，IR05/IR10 不整体勾选。
