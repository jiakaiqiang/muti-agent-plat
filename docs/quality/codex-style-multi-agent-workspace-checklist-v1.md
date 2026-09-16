---
artifact: verification_summary
stage: verification
producedBy: test
schemaVersion: "0.1"
status: draft
result: pending
deliveryId: codex-style-multi-agent-workspace-v1
createdAt: 2026-09-11T00:00:00+08:00
intentContractRef: codex-style-multi-agent-workspace-spec-v1
implementationSummaryRef: codex-style-multi-agent-workspace-tasks-v1
---

# Checklist：Codex 式多 Agent 任务工作区

[Spec](../product/codex-style-multi-agent-workspace-spec-v1.md) · [Plan](../design/codex-style-multi-agent-workspace-plan-v1.md) · [Tasks](../implementation/codex-style-multi-agent-workspace-tasks-v1.md)。

## 1. 状态规则

用户已授权开发，当前已实现主要工作区并执行功能测试。pass 表示所列证据通过；partial 表示仅部分条件通过；blocked 表示需要当前自动化环境以外的验证；pending 表示待验证。总体 result 仍为 pending，不能将主链路通过当成 AC01–AC16 全部完成。截图只证明对应视图，不能替代版本、权限和幂等测试。

## 2. 文档质量校验

- [x] DOC01 四件套存在、deliveryId 一致、相互链接可解析。
- [x] DOC02 已确认决策完整：三栏/三 Tab、节点任务、Diff、通知、任务归属、只读系统流程、系统澄清后选择。
- [x] DOC03 AC01–AC16 均关联 Plan、Tasks 和本清单，无遗漏。
- [x] DOC04 当前事实、目标设计、技术待核查、未实施状态区分明确。
- [x] DOC05 T0–T8 有责任角色、依赖、路径边界、工具政策和验收条件。
- [x] DOC06 文档阶段校验已完成；现已进入业务实现，修改范围和验证记录见 Tasks 第 5 节。

文档阶段历史校验记录（2026-09-11）：四份文件存在性、deliveryId、相对链接、行尾空白、代码围栏、SPEC/AC 覆盖和 T0–T8 必填字段检查通过。此记录只证明最初文档质量；随后实现与功能验证如下。仓库其他既有未提交修改不归入本交付，也不被清除。

## 3. 验收矩阵

| AC | 对应需求 | 实施任务 | 检查与必需证据 | 状态 |
| --- | --- | --- | --- | --- |
| AC01 | SPEC-001 | T1、T3 | 新建任务创建 Session、projectId/workspaceId 分组；历史可回看；独立 WorkItem 自动分流尚未实现（G01） | partial |
| AC02 | SPEC-002 | T3 | 浏览器：初始无 Tab、运行/完成/刷新保留；taskWorkspace 与路由/挂载测试 | pass |
| AC03 | SPEC-003 | T1、T2 | 浏览器群聊确认后启用；workflow-session-flow 测试未确认修订不能启动；复用服务端澄清逻辑 | pass |
| AC04 | SPEC-004 | T1、T2 | published catalog 测试、独立只读目录；authoring-policy 两模式拒绝测试；部署前置 G02 | partial |
| AC05 | SPEC-003、SPEC-004 | T1、T2 | WorkflowCatalog 门控；workflows/runtime/session tests 覆盖版本和重复启动，未确认不启动 | pass |
| AC06 | SPEC-005 | T1、T2、T4 | 浏览器修改并发布 Web 新版后旧快照不变；catalog 隔离未发布 draft；真实快照图截图 | pass |
| AC07 | SPEC-006 | T4 | 浏览器节点→任务→执行详情→关闭恢复右侧只读群聊；agent-task.png | pass |
| AC08 | SPEC-006 | T4 | workflowPresentation.spec 多 Agent、同 Agent 多节点、多轮次、其他运行及空节点隔离 | pass |
| AC09 | SPEC-007 | T4 | 运行详情展示 NodeRun/approval/task；runtime 返工测试保留历史，taskWorkspace 保留选中历史运行 | pass |
| AC10 | SPEC-008 | T5 | 主入口集成统一 store；浏览器固定文件样本验证 split/unified/切换文件/Esc/焦点/零 mutation | pass |
| AC11 | SPEC-008 | T1、T5 | file-history 5 tests 覆盖基线、连续性、多轮回退/去重；非原子采集/外部写入限制 G03 | partial |
| AC12 | SPEC-008 | T5 | historyDiffModel 特殊操作/空文件/缺原文/超限单测；浏览器新增空文件；二进制/图片文本预览明确不可用 | pass |
| AC13 | SPEC-009 | T6 | readonly-chat：不挂载审批组件、不发出决策；浏览器“去处理”回中央，重复计划确认卡已移除 | pass |
| AC14 | SPEC-009 | T6 | historyDiffState 重复通知不关弹窗、不修改内容；event 归一化/连接回归；pending 按 confirmationId | pass |
| AC15 | SPEC-010 | T1、T3、T5、T6、T7 | 请求隔离、历史选择/草稿 sessionStorage、迟到 Diff、SSE 连接、重复启动测试；浏览器刷新后恢复草稿与阅读位置 | pass |
| AC16 | SPEC-010 | T3、T7、T8 | 1440×960/1280×800/1024×720/720×720 浏览器截图及 Esc/焦点；真实 Windows 缩放 G05 | blocked |

## 3.1 桌面交付验收（2026-09-11 追加）

| AC | 对应需求 | 任务 | 必需证据 | 状态 |
| --- | --- | --- | --- | --- |
| AC17 | SPEC-011 | T10/T12/T13 | NSIS 生成；对应 `packaged:true` 程序加载本地工作区；编辑路由和定义写请求拒绝。OS 安装另列 AC22 | pass |
| AC18 | SPEC-012 | T10/T13 | policy 测试、真实 Electron API/SSE、重启配置、切平台 Cookie/localStorage/sessionStorage 隔离 | pass |
| AC19 | SPEC-013 | T11/T13 | 打包 utility process、设备码、隔离平台真实连接、stub 进程与 ChangeSet 写回通过；目录预授权 fixture，原生目录选择和生产平台未实测 | partial |
| AC20 | SPEC-014 | T11/T13 | 真实 invocation 中 stop/configure 拒绝，关窗保留、空闲停止通过；更新单测调用同一停止握手且忙时不安装。保护已接收本地操作，不保证离线后继续远端排队任务 | pass |
| AC21 | SPEC-015 | T12/T13 | 7 tests 含无源/下载失败/忙时不安装/并发安装；普通包更新元数据为空；真实签名下载与旧版升级待验 | partial |
| AC22 | SPEC-016 | T12/T13 | 本地 NSIS、包内容一致性、解包 exe 冒烟通过；NotSigned，干净机器安装/卸载与正式发布未测 | partial |

原 AC01–AC16 的记录是此前浏览器承载桌面工作区的历史证据，不代表 Web 应采用桌面外观，也不作为安装包或桌面更新通过证据。两端展示分离后的验证另列 AC23、AC24。正式签名发布依赖发布方提供证书和更新地址，不在当前会话自动发布。

展示拆分前的历史桌面证据：Windows x64 / Electron 44.3.0 / 内置 Node 24.20.0；当时安装包 112,387,302 bytes，Authenticode `NotSigned`。`.tmp/desktop-electron-smoke.log` 和 `.tmp/desktop-packaged-smoke.log` 分别为当时开发入口与打包程序，均 `result:pass`；后者明确 `packaged:true`。后端使用隔离 HTTP/WebSocket fixture，Agent 为真实子进程中的确定性 stub，不是生产模型。拆分后的最新构建与截图以第 8 节为准。

本次门禁：desktop 7 / helper 81 / Web 239 tests、桌面 typecheck/build、test:harness 通过。全仓库 typecheck/build 被已有 server `persistence.service.ts:21/:48` 重名声明 TS2440 阻塞，证据 `.tmp/desktop-typecheck.log`、`.tmp/desktop-all-build.log`，本次没有修改该后端文件。历史全量测试记录继续保留其原日期和范围。

未关闭桌面事项：D01 正式签名证书及更新发布目录；D02 两版本真实签名升级/失败恢复；D03 干净 Windows 安装/卸载、原生目录选择和缩放。开发测试包与生产发行就绪严格分开。功能与使用说明见 [桌面应用](../devops/desktop-application.md)。

## 4. 主链路场景

### SC01 从需求群聊到固定流程运行

- [ ] 新建任务，系统信息不足时追问，中央无工作流 Tab，右侧展示真实 Agent 状态。
- [ ] 系统生成总结，用户修改后再次确认；确认前流程目录只预览不能使用。
- [ ] 确认后选择系统提供的流程，核对版本并启动，三个 Tab 出现但不抢切当前群聊。
- [ ] 切图查看真实节点；切详情查看同一运行。未点击节点时右侧为只读群聊。

### SC02 节点任务与质量返工

- [x] 点击开发节点，右侧先列关联 Agent 子任务，展开一项查看当前 attempt。
- [x] 验证需返工时显示真实返工路径和原因，历史 attempt 仍可查看。
- [x] 同一个 Agent 出现在其他节点时无记录混入；人工确认节点不生成假 Agent。
- [x] 关闭节点详情恢复群聊；切详情后定位同一子任务及其历史轮次。

### SC03 系统流程目录与历史版本

- [ ] 列表覆盖全部可用系统流程，草稿/未分发流程不误作可用项，失效状态明确。
- [ ] 预览不能编辑节点、连线、发布或删除；客户端身份越权调用写定义接口被拒绝。
- [x] Web 发布新版，客户端目录看到新版本，已运行和历史任务仍展示原快照。
- [ ] 选择至启动之间版本下架或确认修订改变时，不静默换版本、不越过需求确认。

### SC04 全局 Diff 与历史不变

- [ ] 从群聊、节点任务、Agent 任务、详情、产物入口打开同一文件，对应来源身份正确。
- [ ] 第一轮与第二轮分别显示本轮差异，最终交付显示运行基线到最终版本。
- [x] 同文件多轮修改并回退至原内容，累计视图不残留曾出现后已撤销的修改。
- [ ] 后续修改本地文件、重启、切换历史任务后，历史 Diff 内容仍一致。
- [ ] 验证特殊文件和缺失快照的真实降级，弹窗只读，关闭恢复视图和焦点。

### SC05 通知不中断与群聊统一处理

- [ ] 在流程图、详情、节点任务和 Diff 打开时触发通知；均不抢切、不关闭弹窗。
- [ ] Tab 待处理数量正确；同一确认重复推送只计一次，阅读后仍待处理。
- [ ] 流程节点/详情点击“去处理”定位中央群聊中的同一确认卡，不创建副本。
- [ ] 群聊完成处理后三处状态一致；失败、过期、重复提交不重复推进工作流。
- [x] 右侧无输入框或决策提交；允许查看文件和导航至中央处理。

### SC06 恢复、窗口与可访问性

- [ ] A 任务请求延迟时切到 B，返回数据不进入 B 的视图、草稿、Diff 或通知。
- [x] 断线重连仅补数据；已完成任务的 Tab、固定版本和历史选择可恢复。
- [ ] 截图：1440×900、1280×800、1024×720；更窄 Web 窗口侧栏可打开，无功能不可达。
- [ ] Windows 100%/125%/150% 显示缩放实测；不可测时记录 blocked，不用模拟冒充。
- [ ] Tab、节点、任务、弹窗可键盘操作；焦点恢复、状态非仅颜色、长文件名不遮挡操作。

## 5. 执行记录与缺陷

| 日期 | 范围/命令 | 环境与版本 | 结果 | 证据路径/说明 |
| --- | --- | --- | --- | --- |
| 2026-09-11 | `npm run test` | Windows / Node 20.19.6；HEAD 6cdbefb + 既有及本次未提交 diff | pass | `.tmp/codex-workspace-all-tests.log`：local-runtime 81、shared 87、server 1248 + 开发脚本 7、web 238、supervisor 18；合计 1679 pass、4 skip、0 fail |
| 2026-09-11 | workflows/history/authoring/runtime + sessions 定向测试 | tsx 使用 apps/server/tsconfig.json | pass | `.tmp/codex-workspace-server-tests.log`，103 tests；新增 workflow-session-flow 6 tests 亦通过并纳入全量 |
| 2026-09-11 | `npm run test:e2e:codex-task-workspace` | 真实本地 Nest API + fixture Runtime + Chromium | pass | `.tmp/codex-workspace-browser.log`；目录/确认启动/节点任务/人工要求返工/两轮历史/再确认完成/版本冻结/刷新草稿和阅读位置/窄屏；文件 Diff UI 使用明确标记的固定响应样本，不能当成真实 Runtime 文件产出 |
| 2026-09-11 | `npm run test:e2e:rework-loop` | 独立临时服务 + mock runtime | pass | `.tmp/codex-workspace-rework.log`：自动返工一次，达到上限转 WAIT_USER_DECISION |
| 2026-09-11 | `npm run typecheck` | 全 workspace | pass | `.tmp/codex-workspace-typecheck.log` |
| 2026-09-11 | `npm run test -w @project/web`（最终增量） | Windows / Vitest / jsdom | pass | `.tmp/codex-workspace-web-tests.log`：51 files / 239 tests；包含新增旧交付证据归属测试；全量记录的 238 项不回写成 239 |
| 2026-09-11 | `npm run build` | 全 workspace | pass | `.tmp/codex-workspace-build.log`；仍有 Vite 既有大 chunk 提示，不是失败 |
| 2026-09-11 | `npm run test:harness` | 工程门禁全部阶段 | pass | `.tmp/codex-workspace-harness.log` |

截图目录：`output/playwright/codex-task-workspace/`，包含 flow-1440、flow-1280、flow-1024、flow-720、agent-task、rework-1440、diff-unified、diff-split。实际宽屏高度 960，不冒称已测 1440×900。浏览器刷新时被主动取消的 SSE/旧请求属于预期取消；pageerror 必须为空。

| 缺陷 ID | 关联 AC | 现象 | 严重度 | 回退任务 | 状态 |
| --- | --- | --- | --- | --- | --- |
| F01 | AC07 | tasks 是数组，旧适配按 page.items 读取导致右侧无任务 | 高 | T1 | fixed，浏览器节点任务已通过 |
| F02 | AC02/AC05 | 初始化任务会关闭提前打开的目录；测试在未加载消息时提前外部确认 | 中 | T3/T7 | fixed，目录仅真实切任务关闭；主链路经中央群聊确认 |
| F03 | AC13 | 中央旧计划面板重复挂载需求确认卡 | 中 | T6 | fixed，中央 ChatTimeline 为唯一需求确认入口 |
| F04 | AC15 | 关闭 Diff 后迟到响应可能重新打开 | 中 | T5 | fixed，关闭取消请求代次，有单测 |
| F05 | AC05 | workflow-session-flow 旧测试替身缺少 findBySession/get 和 confirmedByUser | 中 | T7 | fixed；6 tests 通过，全量通过 |
| F06 | AC11 | 旧交付证据曾使用当前 Session 最新 runId 查询累计 Diff | 高 | T5 | fixed；现在由 Artifact.taskId → Task.workflowRunId 解析所属运行；historyDiffState 回归通过 |
| G01 | AC01 | 在旧群聊中识别为独立需求仍可能创建同 Session 的新 WorkItem；尚无自动新 Session 分流 | 中 | T1 | open；当前独立需求使用“新建任务”，旧数据不迁移 |
| G02 | AC04 | 缺省兼容本地 Web 作者模式，没有默认用户/租户鉴权 | 高（共享部署） | T1/T2 | deployment prerequisite；共享部署必须配置 token 模式并隔离作者令牌；未修改实际环境 |
| G03 | AC11 | Provider 基线不是原子文件系统快照；缺历史或不连续证据无法复原，未记录的外部写入不受保证 | 中 | T5 | limitation；明确 unavailable/不承诺完整目录原子版本 |
| G04 | AC15 | 刷新后的聊天阅读位置原先未保存 | 低 | T1 | fixed；按任务和区域保存阅读锚点；浏览器刷新恢复阅读位置和草稿通过 |
| G05 | AC16 | Windows 100%/125%/150% 原生显示缩放尚未实测 | 中 | T7 | blocked；Chromium viewport 不替代操作系统缩放 |

## 6. 交付判定

- [ ] T0 的合同/证据缺口已关闭或具备符合规格的明确降级。
- [ ] AC01–AC16 全部取得直接证据，范围与最终实现一致。
- [x] 定向测试、浏览器主链路、typecheck、test:harness、build 记录齐全。
- [x] 已区分模拟 UI 验证、真实服务链路与 Windows 原生验证。
- [ ] 无未解决的阻断缺陷；剩余风险与回退策略明确。

当前结论：`result: pending`，主工作区已实现且主链路/全量测试通过；G01–G05 保留真实状态，不能声称整套规格全部验收。

## 8. 两端展示边界回归（2026-09-11）

| AC | 需求 | 任务 | 必需证据 | 状态 |
| --- | --- | --- | --- | --- |
| AC23 | SPEC-017 | T14 | Web 92px 主导航、会话头像、原四视图、深色工作流、流程编辑可达，Web 资源无桌面 CSS | pass |
| AC24 | SPEC-018 | T14 | 桌面独立入口/样式、无图标任务列表、流程 Tab/节点侧栏、只读目录、Electron 与重打包检查 | pass |
| AC25 | SPEC-019 | T15 | 默认 `dev`（别名 `dev:all`）编译桌面后启动服务；首次健康后确认可见窗口，独立 profile 自动连接同一后端，单实例复用、Windows 直接进程启动 | pass |
| AC26 | SPEC-020 | T16 | 红框内侧栏管理/搜索、中央操作/计划/Token 区域移除且不占位，群聊与右侧进度保留，Web 展示不变 | pass |
| AC27 | SPEC-021 | T17 | 共享输入框上方运行提示；活动会话/连接/近期执行事件联合判断，异常替换、等待确认或结束隐藏，双端位置验证 | pass |
| AC28 | SPEC-022 | T18 | 切回两端刷新列表、会话、事件和详情；终态跨端恢复重新订阅，旧响应不能覆盖新状态 | pass |
| AC29 | SPEC-023 | T19 | 开发入口恢复原授权 Runtime，平台匹配、已在线复用、锁去重、保留目录；桌面窗口真实打开 | pass |
| AC30 | SPEC-024 | T20 | 后台会话完成通知、去重、开关持久化、点击打开会话；原生系统通知回执 | pass |
| AC31 | SPEC-025 | T21 | 底部跟随、历史阅读保留、三点/箭头切换、一键回底；双端与桌面只读群聊 | pass |
| AC32 | SPEC-026 | T22 | 两端输入框停止/继续、保留草稿、意图识别中断、本地结束回执、原会话恢复 | pass |
| AC33 | SPEC-027 | T23 | 纠正次数/时间限制、契约总截止、心跳不覆盖异常、字段错误详情 | pass |

### 群聊停止与结构化输出纠正证据（2026-09-14）

- 加载项目地图、Harness 协议、现有四件套和会话/Runtime/事件合同后实施。停止接入现有 pause/resume；保留原本 Web 顶部入口和独立桌面布局。
- 服务端定向回归 181 项通过（`.tmp/chat-control-server-tests.log`）；新增停止意图识别、实际子进程关闭、未确认/迟到回执后 67 项补充回归通过（`.tmp/chat-stop-regression.log`），阶段总截止及错误详情调整后相关 143 项通过（`.tmp/chat-control-final-unit.log`）。这些集合有重叠，不累加为独立用例总数。
- 前端停止控件、活动提示、原滚动与工作区测试 24 项通过。两端构建通过，日志 `.tmp/chat-control-web-build.log`、`.tmp/chat-control-desktop-build.log`。本地 CLI 类型检查通过。
- 最终两端构建再次通过（含 Vue 类型检查），仍有包体积提示；Harness 16 项通过（`.tmp/chat-control-harness.log`），本轮涉及的已跟踪文件 `git diff --check` 通过。未运行全仓库完整业务测试。
- 双端构建资源冒烟正常退出 0：隔离 HTTP 样本验证真实点击 pause/resume、空输入可停止、草稿保留、暂停清除活动提示、恢复后控件重现；只允许两次明确控制请求，其余视图操作仍零写请求。截图 `output/playwright/client-separation/{web,desktop}-chat-{stopped,stop-control}.png`，桌面运行态已查看。
- 最终双端冒烟通过（`.tmp/chat-control-presentation-final.log`）：特意先通过同步刷新送达 PAUSED，再释放停止接口回执，确认等待期间仍显示禁用的“正在停止…”，不会提前切成“继续”。操作类型按会话保存，恢复请求期间同样保持对应按钮。
- `npm run test:e2e:cancel` 通过（`.tmp/chat-stop-e2e.log`）：隔离后端端口 43379、文件持久化及 mock Runtime，覆盖首轮群聊生成中停止、迟到契约被丢弃、恢复后只生成一个契约，以及原工作流执行暂停/恢复至交付。测试进程正常退出并清理自身服务。
- 未调用真实付费模型、未重启用户业务后端、未操作用户当前任务、未生成安装包。新停止回执与纠正策略需后端加载新构建；开发桌面需重新加载 renderer。

### 群聊滚动证据（2026-09-14）

- `ChatScrollArea.spec.ts` 8 项测试通过：消息追加/同一消息增高、向上阅读保留、完成与暂停/失败/取消/等待状态、连接异常、点击回底恢复跟随、会话锚点隔离、隐藏恢复及观察器清理；连同消息卡片与两端展示回归共 19 项通过。
- 补充工作区、群聊基线和桌面确认卡/只读群聊/历史 Diff 等 36 项回归通过，共 55 项针对性测试；`npm run test:harness` 与 `git diff --check` 通过。
- `npm run build -w @project/web` 与 `npm run desktop:build` 通过，包含两端 Vue 类型检查。构建仍有现有包体积与第三方注释提示，不阻止产物生成。
- `node tests/e2e/client-presentation-smoke.mjs` 正常退出 0。隔离接口样本验证实际双端长消息滚动、同一消息高度增长、历史位置保留、运行三点、完成箭头、按钮水平居中、减少动画、一键回底后继续跟随及桌面右侧只读群聊；同时保留原双端布局、同步与零写请求断言。
- 截图：`output/playwright/client-separation/desktop-scroll-running.png`、`desktop-scroll-completed.png`、`web-scroll-running.png`、`web-scroll-completed.png`。已查看桌面运行态与 Web 完成态，控件位于消息区底部中央，输入框和两端布局保留。
- 本轮未重启业务后端、未运行真实模型工作流、未发布安装包。桌面开发窗口需通过“视图 → 重新加载”加载新 renderer；Web 刷新即可。

### 桌面任务完成通知证据（2026-09-14）

- `npm run test:desktop` 13 项通过，新增 6 项覆盖历史静默、完成去重、失败/取消过滤、再次完成、新会话、网络失败补查、静音、停止丢弃迟到结果和消息内容。
- `npm run typecheck -w @agent-cluster/desktop` 与 `npm run desktop:build`（含 renderer 类型检查）通过。
- `node tests/e2e/desktop-notifications-smoke.mjs` 正常退出 0：真实隔离 Electron 中验证后台隐藏后完成提醒、去重、点击恢复窗口并进入对应路由、开关保存；通知点击用隔离实例内模拟事件驱动，不冒充人工点击 Windows 原生横幅。
- 测试按钮向真实系统发送测试通知，收到原生 show 事件。该回执不等同于确认勿扰模式下横幅可见；结果与说明见 `output/playwright/desktop-notifications/result.json`。设置截图 `settings.png` 已查看，复用既有页面控件和布局。
- 未修改或运行真实模型任务、未重启用户当前桌面/后端、未生成安装包。主进程新增功能需要安全退出并重新打开桌面后生效。

### 原 Runtime 自动连接证据（2026-09-14）

- 补齐手动重启入口：新后端就绪后自动启动/复用原 Runtime。`npm run test:dev-supervisor` 共 33 项通过，新增重启后的自动拉起、已有进程复用、助手失败独立报错及后端未就绪不启动四项。使用注入健康响应验证，未重启用户业务服务；当轮只读 CLI 状态确认原设备在线、4 个目录保留。

- 上轮误用 `dev:web` 导致没有桌面窗口；本轮直接调用桌面 launcher 连接现有后端，收到 visible window 回执，原生进程检查确认工作台窗口句柄非零。桌面构建通过。
- `npm run test:dev-supervisor` 29 项通过，覆盖后端就绪前不启动、就绪后仅启动一次、连接恢复不重复启动、未授权/平台不匹配跳过、独立进程及锁复用/失效恢复。
- 实际自动连接返回原 deviceId `1670d1d4-2b92-4c3d-a4cd-fd5c9d717d39` 与 4 个工作目录；再次调用返回 existing。CLI `status` 返回 `Authenticated: yes`、`Connected: yes`、`Workspaces: 4`。
- 当前后端保持原进程运行；没有为验证重启业务服务，也未执行模型任务或发布安装包。服务中断后重连复用既有 CLI transport；本轮未对真实任务执行断网恢复实验。

本次恢复不撤销 Web 既有工作流 Agent 链、心跳日志合并、质量返工和连接修复。截图与浏览器样本只证明展示隔离，不替代生产后端业务、原生安装或正式签名更新验收。

本次验证证据：

- Web typecheck/build：`.tmp/web-separation-typecheck.log`、`.tmp/separation-web.log`；桌面 renderer 的 vue-tsc/build：`.tmp/separation-final-build.log`。两端分别输出 `apps/web/dist` 与 `apps/desktop/dist/renderer`。
- 既有两端组件/业务回归：`.tmp/separation-tests.log`，53 files / 247 tests pass；新增实际挂载的两端列表边界测试：`.tmp/separation-boundary-unit.log`，1 test pass。测试明确 Web 保留头像而桌面没有头像占位，并验证两端状态更新与选择事件。
- 双构建资源回归：`npm run test:e2e:client-presentation`，`.tmp/separation-presentation.log`。同一接口 fixture 验证主导航、列表、工作流、只读目录及零写请求；Web 加载的 CSS 不含 `.task-workspace`。
- 1440×960 截图已逐张检查：`output/playwright/client-separation/web-chat.png`、`web-workflow.png`、`desktop-chat.png`、`desktop-workflow.png`。
- 真实 Electron：`.tmp/separation-electron.log`（开发入口）和 `.tmp/separation-packaged.log`（`packaged:true`）；助手设备授权、实际 stub invocation/写回、忙时拒绝停止、窗口关闭保留助手、跨平台存储隔离通过。
- 桌面单测 7 pass：`.tmp/separation-desktop-unit.log`；Harness 通过：`.tmp/separation-harness.log`；Git whitespace 检查通过。
- 安装包重新生成于 `output/desktop/Agent-Cluster-Setup-0.1.0-x64.exe`，仍为本地未签名测试包；`.tmp/separation-package.log`。未发布、未执行系统级安装/卸载。
- 本轮没有重跑全仓库 server 构建及依赖它的完整真实工作流 E2E：既有 `persistence.service.ts` TS2440 阻塞仍单独保留；两端展示采用隔离样本和实际 Electron 验证。原 `test:e2e:codex-task-workspace` 已改为加载桌面 renderer，不能将旧入口记录当作此次完整主链路已重跑。

### 统一启动追加证据

- `npm run desktop:build` 与 `npm run test:harness` 通过：`.tmp/unified-desktop-build.log`、`.tmp/unified-harness.log`。本次未修改已安装产品代码，不需要重新发布安装包。
- `npm run test:dev-supervisor`：22 tests pass，`.tmp/unified-dev-tests.log`。覆盖健康前不打开桌面、健康恢复不重复启动、桌面启动失败和停止后的迟到响应。
- `npm run test:e2e:unified-desktop-launch`：真实 Electron 使用 launcher 的配置/参数/环境打开工作台；自动本地连接、独立 userData、清除 Node 模式、重复启动复用窗口通过。`.tmp/unified-desktop-launch.log`，后端为隔离 HTTP fixture。
- `npm run test:e2e:unified-dev`：真实 Nest 后端、Web Vite/API 代理、Electron 工作台同时启动通过。使用临时空白数据和空闲端口，不调用模型；测试结束关闭桌面并清理本次服务。`.tmp/unified-dev-smoke.log`。
- 追加验证中曾发现工作区后端缺少 `cancelIntentRoutingRetries` 导致编译失败；复查时该方法已补齐，随后真实后端启动通过。本次未修改后端模块，先前 TS2440 不再作为当前启动阻塞。以上不代表完整业务测试或正式安装包升级通过。

### 桌面未打开的返工闭环（2026-09-11）

- 用户实际执行的默认 `npm run dev` 此前仍只启动后端/Web；现已作为三端统一入口，`dev:all` 为别名，`dev:web` 提供原服务启动能力。
- 原 Windows launcher 设置 `windowsHide: true`，直接创建 Electron 时会隐藏首次窗口。此前 Playwright 替代了进程创建，未覆盖这一差异。现改为 `false`，并等待与本次启动关联的可见窗口/后端回执，超时或错误明确失败。
- 桌面构建通过：`.tmp/desktop-open-build.log`。25 项 supervisor/launcher/restart 单测通过：`.tmp/desktop-open-unit.log`，包括无回执、隐藏窗口、后端不符、错误回执、提前崩溃及成功回执消费。
- `test:e2e:unified-desktop-launch` 通过：`.tmp/desktop-open-launch.log`；新增直接 detached spawn 的实际 Electron 窗口验证，保留自动连接、隔离配置和单实例检查。
- `test:e2e:unified-dev` 通过：`.tmp/desktop-open-unified.log`；使用隔离数据与端口 23262/34021 验证真实 Nest、Web Vite/API 代理及桌面同时启动，结束后仅清理测试进程。
- 直接连接用户现有 8099 后端打开桌面；原生窗口检查确认 PID 37464、标题“工作台 · 多 Agent 协同工作平台”及非零窗口句柄。保留用户当前桌面和服务，不重启业务进程。本轮未重新生成或发布安装包。
- 文档同步后 `npm run test:harness` 通过（`.tmp/desktop-open-harness.log`），Git whitespace 检查通过。未重跑全仓库业务测试；本轮验证聚焦开发启动与窗口展示。

### 桌面红框区域精简证据（AC26，2026-09-11）

- 依据用户新截图覆盖旧左侧常驻流程管理约定；仅修改独立桌面组件和布局，旧搜索条件不再隐式过滤任务，确认卡中的只读目录入口保留。
- `npm run desktop:build` 通过，包含 renderer 类型检查：`.tmp/desktop-simplify-build.log`。
- 既有双端展示/桌面侧栏单测 4 项通过：`.tmp/desktop-simplify-unit.log`。双端构建资源冒烟通过：`.tmp/desktop-simplify-visual.log`，使用隔离接口样本验证 Web 基线、桌面红框区域缺席、工作流切换和节点右栏。
- 人工查看生成的 `output/playwright/client-separation/desktop-chat.png`，任务列表、标题、工作流 Tab、聊天及右侧 Agent 保留，消息区域填满剩余高度，输入框位于底部。
- 现有真实业务冒烟改为从群聊确认卡点击“管理工作流”；本轮未重跑完整业务流程、未重打安装包，当前开发窗口可通过“视图 → 重新加载”加载新 renderer。

### 共享任务运行提示证据（AC27）

- 共享 `UserInputBox.vue` 接入 `utils/taskActivity.ts`，Web 和桌面调用点无需分别修改。两端独立外观继续保留。
- 状态工具 4 项测试及既有双端展示单测通过：`.tmp/task-activity-unit.log`。覆盖连接异常、跨会话旧信号、90 秒无新进度、失败与重试、完成/暂停/等待决策。
- Web 与桌面构建（含类型检查）通过：`.tmp/task-activity-web-build.log`、`.tmp/task-activity-desktop-build.log`。
- 双端页面断言通过：`.tmp/task-activity-visual.log`，隔离 API 与事件连接样本验证提示文案、位于输入框上方、任务完成后移除和原布局。截图为 `output/playwright/client-separation/web-chat.png`、`desktop-chat.png`；桌面截图已查看，提示未遮挡消息或输入框。测试停在浏览器退出等待，未取得正常退出码；已针对确认为本次测试的进程执行清理，不将断言通过等同于完整测试进程正常退出。
- 本轮未修改后端、未执行真实模型任务、未生成安装包；提示表示近期收到运行信号，不能证明模型最终成功，也不修复此前诊断的数据库写入积压。

### 跨客户端同步证据（AC28）

- 实际开发 Web 配置 API/SSE 均为 `/api`，8089 代理与桌面 8099 后端健康返回相同 processId/dataEpoch，排除已核查配置连接不同数据库。未能读取用户浏览器当前页签（浏览器连接凭据不可用），不宣称已核对用户两端打开的是同一 sessionId。
- 根因：原 visible 回调只调用 retrySseNow，connected/connecting 直接返回；列表/详情只在初次载入或本端操作时刷新，终态断开 SSE 后缺少跨端恢复入口。
- 共享 `useWorkspaceSync` 接入两端工作区，focus/visible/online 与关键事件刷新，前台 15 秒补查；保留选中任务、视图、节点及输入草稿。Session store 防迟到响应回退，状态事件使用服务端时间。
- 36 项同步、事件连接、会话文件修订/路由/删除及工作区测试通过：`.tmp/workspace-sync-unit.log`。两端构建及类型检查通过：`.tmp/workspace-sync-web-build.log`、`.tmp/workspace-sync-desktop-build.log`。
- 双端页面同步冒烟通过并正常退出：`.tmp/workspace-sync-visual.log`。隔离 API 与事件流样本模拟另一端完成任务和新增消息，在本页仍为 connected 时通过 focus 补拉；终态后远端恢复执行再次回焦，状态恢复 running。保留双端布局及只读检查，未操作用户真实任务。
- 验证过程中修正测试消息冒号被渲染为字段导致的定位误判，并为测试浏览器加入有界关闭/所属进程清理，避免退出等待隐藏断言结果。Git whitespace 检查通过；未执行真实模型工作流、未发布安装包、未重启后端。
