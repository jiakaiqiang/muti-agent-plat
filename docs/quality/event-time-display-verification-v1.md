# 双端事件时间显示验收（2026-09-29）

## 范围与约束

按用户要求，Web 和客户端共用 `apps/web/src/utils/dateTime.ts`，统一日期时间显示为 `YYYY年MM月DD日 HH:mm:ss`。按项目地图、Harness 协议与 [UI 状态合同](../contracts/ui-state-contract-v0.1.md#双端时间显示2026-09-29) 实施。仅修改展示，不修改事件源、API、持久化、排序、原始诊断 JSON、日志正文和相对时长。

已接入入口：两端聊天时间、Web 折叠停止回执、协作日志/计划/任务输出与活动时间、Runtime 消息及观测详情、审计、文件基线、客户端工作流运行/任务/实施记录、历史 Diff 来源，以及 Agent/Skill/工作流/知识库更新、Runtime 连接/启动/构建时间标签。客户端共享 Web 领域工具及管理组件，保留独立 renderer 和样式。

空值或无效值使用场景原空态文案或 `—`；年月日及时间补零，24 小时制，沿用本地时区。完整日期较长，两端消息头和协作日志头支持换行，不改变布局体系。

## 自动化结果

- `npm run test -w @project/web`：76 文件、395 项通过，包含客户端 renderer 测试。
- 新增 `dateTime.spec.ts`：精确格式、两位补零、午夜、时区偏移输入、ISO/毫秒/Date、闰日、跨年、无效值与源 Date 不变。
- 新增 `EventTimePresentation.spec.ts`：Web/客户端不同发送者的实际消息头、折叠停止回执、协作日志/计划、客户端任务和实施记录；源事件时间保持不变。
- Runtime 消息弹窗追加日期格式断言，原等待/停止及历史保留回归仍通过。
- Web 类型检查、Desktop renderer 类型检查通过；Web 构建通过；`npm run test:harness` 通过。
- 构建保留原有 PURE 注释/大 chunk 警告；组件测试触发 `WorkflowExecutionDetails` 原有 `<p>` 内嵌 `<details>` 警告，本次未修改无关标记结构。
- 源码扫描确认双端展示区不再使用 `toLocaleDateString`、`toLocaleTimeString` 或 `Intl.DateTimeFormat` 的默认日期格式；数字 `toLocaleString`、业务时间计算和 ISO 序列化不变。

## 浏览器结果与边界

隔离 fixture：`apps/web/tests/fixtures/event-timestamps.html/.ts`，所有 fetch 本地 stub，无后端/CLI/真实模型参与。实际挂载两端 ChatTimeline 和共享日志/Runtime 组件，不是打包 Electron E2E。

- Web 与客户端：1440×900、390×844，聊天时间均为 `2026年09月29日 15:04:05`。
- 390px 双端 documentWidth=390；未发生新增横向溢出。
- 宽屏协作日志与窄屏 Runtime 消息使用相同完整时间格式。Runtime 历史消息仍逐条保留。
- 观察过程中 mutation 请求数为 0。只打开/关闭展示弹窗，没有等待、停止或重试模型操作。
- 有两次浏览器引用失效和一次空白页面；重新建立命名会话后按新快照复验。无效截图不计入结果，交付截图均已替换并人工复核。

有效截图位于 Git 忽略的 `output/playwright/`：

- `event-dates-web-wide.png`
- `event-dates-web-mobile.png`
- `event-dates-desktop-wide.png`
- `event-dates-desktop-mobile.png`
- `event-dates-runtime-mobile.png`

未重启原服务，未执行提交、发布、部署、数据库或 DingTalk 操作；未构建或安装新 Electron 安装包。已有安装版需通过后续正常打包/更新加载客户端修改。
