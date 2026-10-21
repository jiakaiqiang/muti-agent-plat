# 原消息纠错入口与客户端状态开发记录

日期：2026-10-19。依据 Spec/Plan/Task/Checklist 实现 IR10 的客户端增量。原始验收范围不变，IR10、IRC-AC15、X02 和 G3 仍为部分完成；本报告不代表整个专项完成。

## 已实现的行为

- Web 与 Desktop 时间线的用户消息增加“纠正理解”，共用 `IntentCorrectionPanel` 和 `intentCorrection` Store。Desktop 的只读时间线不提供写入口。面板展示原消息，选择目标任务、可选的已确认约束及精确纠正内容；继承约束已被本地覆盖时不再列入选择。
- 增加 `GET /sessions/:sessionId/message-routings?sourceEventId=...`，按原消息精确查找持久化路由，设置 `Cache-Control: no-store`；不依赖发送时的缓存或 debug 快照。缺少 sourceEventId 返回 400，不存在的 Session 返回 404；零个或多个匹配不擅自选目标。旧首轮消息无路由记录时明确说明。
- POST 前冻结原 session/routing、路由 revision、目标任务、被替换 Decision/revision、原始内容和幂等键。网络失败、408、429 和服务端异常保留同一请求，允许刷新核对或原样重试；关闭面板和切换会话不改变未决请求的目标。收到持久化同键记录即可确认原请求已被接收。
- 409/410 后刷新当前路由和纠错历史，表单还会重新加载任务与约束；保留冲突反馈，不自动改版本再次提交。刷新失败时禁止创建新请求。明确的 4xx 拒绝不沿用已失败的请求；新的显式提交创建新键。
- 严格区分 accepted、waiting_for_stop、validating、clarification_required、applied、reconciliation_required、rejected。202 只显示受理，401/配置失败不冒充语义澄清；待对账禁止另一提交，applied 提醒暂停会话仍需单独恢复。
- 面板打开期间每秒查询处理状态，最多 120 次；关闭、卸载或消息切换会取消读请求和计时器。达到上限显示稍后刷新，不伪判失败。打开或手动刷新重新核对，SSE 丢失不阻止查询恢复；尚未接完整 SSE 状态订阅。
- API 边界对消费字段做运行时校验，拒绝跨会话、跨消息、未知状态、非法版本和损坏列表。并发读取通过请求代次防乱序，历史优先采用较高 routingRevision，再比较更新时间。成功后未修改的表单不能原样重复提交。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 新增共享 Store 与双时间线组件场景 | 21 项，通过于最终 Web 全量回归 | `intentCorrection.spec.ts` 11 项、`IntentCorrectionPanel.spec.ts` 10 项 |
| Web 全量测试，含 Desktop Vue 组件 | 466 通过，0 失败 | `correction-ui-web-regression-final.log` |
| SessionsService 回归，含原消息查询隔离 | 148 通过，0 失败 | `correction-ui-session-regression.log` |
| 全仓类型检查 | 退出码 0 | `correction-ui-typecheck-final.log` |
| 全仓构建，含 Desktop renderer 类型检查与打包 | 退出码 0 | `correction-ui-build-final.log` |
| Harness 检查 | 退出码 0 | `correction-ui-harness.log` |
| localhost API、Generic LLM HTTP、进程重启 | CA01–CA06、CU01–CU03 共 9 项通过 | `correction-ui-http-results.json`、`correction-ui-http.log` |
| 实际浏览器共享组件交互 | 已验证原约束选择、内容输入、受理禁用、生效反馈与防原样重复提交 | `correction-ui-browser-accepted.txt`、`correction-ui-browser-applied.txt`、`correction-ui-browser.png` |

HTTP 使用已构建的后端、独立 File 数据和确定性本机 provider，不修改 `.env` 或现有连接。CU01 验证按原消息精确查找，CU02 验证缺参数和会话隔离，CU03 验证重启后可找回已生效版本。CA 场景仍验证并发幂等、hold、约束替换、无隐式恢复及重启重放。最后的改动只涉及客户端，后端源码在此次 HTTP 验证后未变。

浏览器验证运行 `node tests/evaluation/serve-intent-correction-ui.mjs`，用内置浏览器操作真实 Vue/Element Plus 组件。该页面的网络层为内存 fixture，未连接产品数据；它不是实际 Web 应用与 Electron 各启动一个客户端的联调。截图已人工检查，原消息、标签、选择、状态、历史入口和底部按钮可见且无重叠。

初次新增测试 20/20、第一次前端全量 465/465 保留为中间记录；随后新增一项状态版本防倒退测试，最终为 466。各次回归有重叠，不能相加作为独立意图题数。此次只运行受影响范围测试，未重新运行整个仓库 `npm run test`；上一里程碑的 2853/21 跳过计数不冒充当前全仓结果。

构建有依赖注释及大 chunk 警告，未作无关打包重构。浏览器 fixture 初次启动遇到 Windows ESM 绝对路径问题，已改用 `pathToFileURL` 后启动成功。

## 当前限制和后续工作

1. 面板依赖明确原消息及目标任务；普通聊天自动识别纠正、无目标澄清、新语义主入口和首轮统一路径仍待完成。
2. 后端仍仅能激活无执行效果的单段纠错；执行型计划、外部效果对账与补偿入口未完成。界面不会把受理或待对账显示为执行成功。
3. 尚未执行实际 Electron + Web 双客户端并发、SSE 注入/断连、PostgreSQL/CLI 环境验收，IR10.4/X02 不勾选。组件测试和 Desktop 构建不替代这些验收。
4. 未执行真实模型准确率评测、完整 58 场景、500+ 独立双人标注、灰度发布与回滚。`ordered_plan` 保持关闭；没有提交、部署、发布或生产数据迁移。

源码/日志指纹及明确的验证范围见 `correction-ui-manifest.json`。此前 activation/versioned 报告及 manifest 保留，不回写旧证据。
