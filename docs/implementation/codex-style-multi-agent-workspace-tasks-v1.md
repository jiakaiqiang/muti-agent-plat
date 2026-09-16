---
artifact: task_plan
stage: planning
producedBy: coordinator
schemaVersion: "0.1"
status: in_progress
deliveryId: codex-style-multi-agent-workspace-v1
createdAt: 2026-09-11T00:00:00+08:00
designPlanRef: codex-style-multi-agent-workspace-plan-v1
---

# Tasks：Codex 式多 Agent 任务工作区

[Spec](../product/codex-style-multi-agent-workspace-spec-v1.md) · [Plan](../design/codex-style-multi-agent-workspace-plan-v1.md) · [Checklist](../quality/codex-style-multi-agent-workspace-checklist-v1.md)。

## 1. 执行规则

追加 T22 / AC32：共享输入框停止/继续，两端接线、异步会话隔离、意图识别取消传播及暂停后恢复、本地结束回执与未确认处理；单测及隔离接口/Runtime 冒烟验证。追加 T23 / AC33：按调用监督一次格式纠正与 5 分钟时限，契约阶段 20 分钟总时限，保留校验明细并纠正活动提示；覆盖重复事件、心跳、迟到结果、并行调用及超时。两项已实现并完成定向验证，证据及限制见 Checklist；未重启用户业务服务或更新安装包。

追加 T21 / AC31：实现共享消息滚动容器、三点/箭头控件与阅读恢复；接入 Web、桌面中央及右侧群聊；保留独立样式和确认卡定位接口。针对流式高度变化、历史阅读、新消息、状态变化、一键回底、会话隔离和隐藏恢复做单测，使用两端构建资源验证实际滚动与控件位置，证据回填 Checklist。

用户已授权按四件套开发；2026-09-11 已实现工作区主链路并进入集成验收，范围与证据见第 5 节。assignee 表示责任角色，不代表自动创建代理或派发任务。细项包含多个条件时，仅部分完成仍保留未勾选；文档或界面存在不等于全部验收完成。

实施开始前重新检查根及目标目录的 AGENTS.md、Git diff 和受影响合同，保护既有未提交工作。所有任务继承以下 forbiddenPaths/权限约束：不修改无关业务、Runtime 选择与质量返工算法、Web 作者端编辑权限、历史数据；不执行 Git 提交推送、发布部署、外部通知或破坏性清理。

T0 的差距核查必须先形成接口/样本证据。后续新增端点、持久化结构与兼容处理先回填 T1 合同，不允许前端以假数据弥补。需要改动领域行为或扩展目标范围时明确记录，不凭 UI 改造默许新业务。

展示路径纠正：T2–T7 原文中的桌面展示组件、路由和 CSS 路径从 `apps/web/src` 改为 `apps/desktop/renderer`。Web 仅允许恢复原展示及维护共享逻辑；旧路径记录说明此前实施过程，不再授权改变 Web 外观。

## 2. 任务拆解

### T0 核查真实基线与数据差距

- assignee: architect
- dependsOn: []
- allowedPaths: `apps/web/src/**`、`apps/server/src/modules/{workflows,sessions,tasks,artifacts,events,persistence,workspaces}/**`、`packages/shared/src/**`（只读）；本交付四份文档（差距回填）。
- forbiddenPaths: 所有生产代码写入、无关文件、历史记录。
- toolPolicy: read-only diagnostics；仅允许本交付文档写入。
- [x] 核对流程发布/分发身份来源、客户端只读与 Web 编辑端能力边界，记录现有端点和响应样本。
- [x] 核对需求澄清、Brief 修订确认、选择版本、启动幂等的现有路径。
- [x] 核对历史运行快照、NodeRun/Task/Artifact/attempt 关联、旧多 WorkItem 会话兼容。
- [x] 核对本轮与最终累计 Diff 的两端内容保存能力，包括 non-Git 与缺失旧数据。
- [ ] 保存未修改前的关键页面截图，列出需更新的既有测试、旧路由、性能阈值与缺口。
- acceptanceCriteria: 差距表逐项标记“现有可复用/需补齐/不支持且如何降级”，不得把未核查标记为可用；为 AC01–AC16 建立真实基线。

### T1 固化身份关联、读取合同与 UI 状态

- assignee: architect/backend
- dependsOn: [T0]
- allowedPaths: `packages/shared/src/**`、`apps/web/src/{types,stores,router}/**`、相关 server 查询及持久化模块、`docs/contracts/**`、本交付文档和对应测试。
- forbiddenPaths: 独立新执行引擎、无关数据库迁移、改变接单/质量决策语义。
- toolPolicy: scoped file edits；定向合同/状态测试；不操作真实生产数据。
- [ ] 确定新产品任务到 Session/WorkItem 的映射及新独立需求创建入口，兼容读取旧数据。
- [x] 固化发布流程目录、固定版本运行快照、节点任务历史和文件版本证据的读取合同；必要时补齐 API。
- [ ] 明确客户端身份不能写流程定义的服务端校验，不依赖客户端标志提权。
- [x] 实现任务维度的 Tab、selectedRun、node/task/attempt、draft、滚动锚点状态与旧路由兼容。
- [x] 固化未解决通知身份、定位与去重规则；定义 Diff 来源、范围、完整性和降级状态。
- acceptanceCriteria: AC01、AC03、AC04、AC05、AC06、AC11、AC15 的数据与权限不变量均有合同和定向测试。

### T2 实现只读流程管理与需求确认后使用

- assignee: frontend/backend
- dependsOn: [T1]
- allowedPaths: `apps/web/src/views/**`、`apps/web/src/components/**`、`apps/web/src/{stores,api,router}/**`；server workflows/sessions 相关接口、shared 合同与对应测试。
- forbiddenPaths: 客户端流程编辑/发布/删除入口；先选流程新建任务捷径；静默改选最新版。
- toolPolicy: scoped file edits；本地模拟数据与接口测试，不向外部分发系统写数据。
- [x] 建立独立只读目录与预览，覆盖系统全部可用流程的加载、分页/刷新、空态及失效。
- [x] 接入系统澄清、需求总结与用户确认，修订后旧确认不能继续启动。
- [x] “使用”绑定当前已确认需求且未启动的任务；无有效上下文给出对应提示。
- [x] 启动校验明确版本和确认身份，成功后读取固定快照，重复请求只启动一次。
- acceptanceCriteria: AC03–AC06 通过；客户端没有定义写请求，Web 作者侧既有维护功能仍正常。

### T3 实现三栏工作区与三 Tab

- assignee: frontend
- dependsOn: [T1, T2]
- allowedPaths: `apps/web/src/components/{AppShell,SessionSidebar,SessionWorkspace,UserInputBox,ChatTimeline}.vue`、相关 stores/router/styles、对应测试；必要的新工作区组件。
- forbiddenPaths: 删除旧路由、重写无关管理页面、改业务执行状态。
- toolPolicy: scoped file edits；组件测试；本地浏览器检查。
- [x] 左侧项目/历史任务与流程管理常驻，收敛重复导航；保留原管理功能的可达入口。
- [x] 中央仅在真实运行产生后出现三 Tab，历史终态及刷新后保留；加载不误判为空。
- [x] 群聊中央支持现有输入及确认，右侧展示 Agent 真实状态与进度。
- [x] 新运行和新通知都不抢切；切换任务隔离草稿与异步返回。
- [ ] 应用 Plan 中布局基线、独立滚动、窄窗口可恢复入口及键盘导航。
- acceptanceCriteria: AC01、AC02、AC15、AC16 的组件和浏览器场景通过；现有管理入口未丢失。

### T4 实现所选流程图、节点任务与执行详情

- assignee: frontend/backend
- dependsOn: [T1, T3]
- allowedPaths: `apps/web/src/components/WorkflowRuntimeView.vue`、相关 workflow 组件/纯函数模型、AgentStatusPanel、stores/api；server 运行历史读取与对应测试。
- forbiddenPaths: 按 Agent 去重生成业务图、硬编码需求开发验证节点、虚构多 Agent、修改原始流程结构。
- toolPolicy: scoped file edits；状态/组件测试；只读历史查询。
- [x] 从 definitionSnapshot 展示节点连线并叠加运行/等待/返工状态。
- [x] 点击节点切换右侧任务列表，点击子任务展开实施、测试、产物及轮次。
- [ ] 覆盖同 Agent 多节点、多任务、多 attempt、人工节点、改派与无任务状态。
- [x] 独立工作流详情展示阶段、依赖、实施记录、验证、交付和历史运行/轮次。
- [x] 节点任务与详情精确互相定位，关闭节点详情恢复只读群聊。
- acceptanceCriteria: AC06–AC09 通过；任何视图都无法把其他运行或轮次的记录混入当前选择。

### T5 实现全局历史文件 Diff 弹窗

- assignee: frontend/backend
- dependsOn: [T1, T4]
- allowedPaths: `apps/web/src/components/**` 中文件入口和 Diff 组件、stores/api；server artifacts/workspaces/persistence 版本证据相关路径、shared 与对应测试。
- forbiddenPaths: 读取当前工作目录冒充历史、拼接 patch 作为累计 Diff、复用文件编辑/应用写回回调。
- toolPolicy: scoped file edits；临时测试样本与定向测试；不修改用户项目文件。
- [ ] 补齐/复用执行前后不可变内容和工作流开始到交付的基线引用，明确旧数据降级。
- [x] 全部任务/产物变更文件入口调用同一只读查看器，显示范围与版本来源。
- [x] 支持左右/行内对比、行号、增删上下文、同集合文件切换、关闭位置/焦点恢复。
- [x] 覆盖新增、删除、重命名、空文件、二进制、缺失/超大/截断与普通未变更引用。
- [x] 使用同一文件多轮修改、修改后回退原内容的样本验证累计差异；验证本地后来修改不影响历史。
- acceptanceCriteria: AC10–AC12、AC15 通过；只读操作网络轨迹无业务写入。

### T6 实现通知集中处理和只读群聊联动

- assignee: frontend
- dependsOn: [T3, T4, T5]
- allowedPaths: `apps/web/src/components/{ChatTimeline,CollaborationLogPanel,ConfirmationCard,SessionWorkspace}.vue`、workflow 视图、相关 stores/api/测试、新导航公共函数。
- forbiddenPaths: 右侧输入/审批、流程页直接决策、重复生成通知、自动关闭 Diff。
- toolPolicy: scoped file edits；组件与模拟通知测试。
- [x] 共用消息归一化，右侧只读且文件仍可查看；只读属性阻断嵌套确认组件回调。
- [x] 群聊统一处理；另外两个视图通过同一入口定位原确认卡。
- [x] pending 按确认身份去重，解决状态统一；未读计数不混同待处理计数。
- [x] 新通知不抢视图/轮次/弹窗，向上阅读不被强制拉到底，失败确认保留待处理。
- acceptanceCriteria: AC13–AC15 通过，含重复事件、过期确认、消息尚未加载及点击去处理场景。

### T7 集成与视觉验收

- assignee: test
- dependsOn: [T2, T3, T4, T5, T6]
- allowedPaths: 相关 `*.spec.ts`、`tests/e2e/**`、必要测试脚本注册、`output/playwright/**`、本交付 Checklist。
- forbiddenPaths: 为通过测试改业务语义、运行外部生产任务、把模拟验证当真实客户端验证。
- toolPolicy: 本地单测/浏览器测试/构建；按样本清理测试临时目录，不做广泛清理。
- [ ] 执行 Checklist 的全链路、历史版本、Diff、通知、只读权限和跨任务场景。
- [ ] 记录宽屏/窄窗口截图、键盘/弹窗恢复、Windows 缩放检查及控制台错误。
- [x] 跑最小定向测试和全局门禁，记录环境、HEAD、关联 diff、命令和实际结果。
- acceptanceCriteria: AC01–AC16 逐项有 pass/fail/blocked 及证据；失败项定位对应任务，不能空口通过。

### T8 Review 与交付回填

- assignee: review
- dependsOn: [T7]
- allowedPaths: 本交付四件套、相关合同/设计/项目地图的索引与实施证据。
- forbiddenPaths: 生产代码写入、发布部署、覆盖无关修改。
- toolPolicy: read-only review；文档回填。
- [ ] 核对最终实现符合本次已确认选择，复核只读、历史不可变、审批归属和版本边界。
- [x] 回填实施范围、证据、残余风险、兼容行为与回退方式，更新入口索引。
- acceptanceCriteria: AC01–AC16 均可追踪；未解决缺陷明确列出；不将“文档完成”标成“功能交付”。

## 2.1 桌面交付补齐任务（同一 deliveryId）

### T9 修正范围并补齐桌面合同
- assignee: architect
- dependsOn: [T0]
- allowedPaths: 本四件套、项目地图、桌面运维说明。
- forbiddenPaths: 覆盖既有验收证据、重设计已确认业务。
- toolPolicy: scoped file edits。
- [x] 将误排除的桌面交付补回，追加 SPEC-011–016 / AC17–22。
- acceptanceCriteria: 同一套文档可追踪界面与真正客户端交付，旧缺陷仍保留。

### T10 桌面壳与平台连接
- assignee: implementation
- dependsOn: [T9]
- allowedPaths: `apps/desktop/**`、Web 桌面适配、根 package/lock。
- forbiddenPaths: 开发服务器当生产入口、任意 shell IPC、客户端流程编辑。
- toolPolicy: scoped edits、依赖安装、本地构建。
- [x] 实现内置资源、受限协议代理、SSE、平台设置、存储隔离与只读边界。
- acceptanceCriteria: AC17、AC18；真实 Electron 加载且不依赖开发服务器。

### T11 集成本地助手与安全退出
- assignee: implementation
- dependsOn: [T10]
- allowedPaths: 桌面进程、local-runtime-cli 可选生命周期接口、相关 Web 接口和测试。
- forbiddenPaths: 改变执行位置、强杀忙碌助手、自动重放任务、自动授权项目目录。
- toolPolicy: scoped edits、隔离测试助手状态。
- [x] 内置助手启动/设备授权/状态；忙闲握手、关闭保留与退出保护。
- acceptanceCriteria: AC19、AC20；invocation 与文件操作期间拒绝停止。

### T12 安装与受控更新
- assignee: implementation
- dependsOn: [T10, T11]
- allowedPaths: 桌面打包、更新、脚本、运维说明。
- forbiddenPaths: 未授权上传/签名发布/部署、更新中断任务、把配置存入安装目录。
- toolPolicy: 本地 NSIS 构建；外部发布不执行。
- [x] 生成本地 NSIS 安装包，提供更新状态/检查/下载/安全安装与正式发布前置校验；正式签名渠道未配置。
- acceptanceCriteria: AC21、AC22；无更新源和未签名状态明确。

### T13 桌面验证与证据回填
- assignee: verification
- dependsOn: [T10, T11, T12]
- allowedPaths: 相关测试、输出证据、本四件套/运维文档。
- forbiddenPaths: 把 mock 当生产升级、用浏览器 viewport 当原生显示缩放。
- toolPolicy: 单测、Electron 冒烟、安装包检查、全局适用门禁。
- [x] 回填实际命令/结果、安装包位置和未验项；正式签名升级、干净机器安装与原生目录选择仍待验收。
- acceptanceCriteria: AC17–22 逐项 pass/partial/blocked，正式分发缺口明确。

### T14 两端展示分离与 Web 恢复
- assignee: implementation / verification
- dependsOn: [T3, T10, T13]
- allowedPaths: `apps/desktop/renderer/**`、桌面构建/依赖、已核查的 Web 展示文件、两端回归测试及本四件套。
- forbiddenPaths: 无关后端改动、清除工作树、将桌面样式重新引入 Web、丢失现有返工与连接修复。
- toolPolicy: 读取差异后 apply_patch；独立构建与隔离 fixture；本地打包，不发布。
- [x] 分离 HTML/main/router/AppShell/工作区组件/全局 CSS；恢复 Web 主导航和会话头像。
- [x] 保留两端共用的 API、状态、合同、业务修复及桌面助手/安装/更新能力。
- [x] 完成双端视觉、Electron、安装包回归并回填证据；详见 Checklist 第 8 节。
- acceptanceCriteria: AC23、AC24；Web 产物无桌面 CSS，桌面任务无头像，两端工作流/管理边界符合各自规格。

### T15 一条命令启动 Web 与桌面
- assignee: implementation / verification
- dependsOn: [T10, T14]
- allowedPaths: 根 package scripts、`scripts/dev-all*`、`scripts/dev-desktop*`、`apps/desktop/src/main.ts` 的开发启动回执、隔离启动测试与运维/SDD 文档。
- forbiddenPaths: 改两端外观、覆盖已安装客户端配置、自动授权助手、强杀正在执行的桌面助手、无关后端改动。
- toolPolicy: scoped edits；进程单测；临时数据/空闲端口真实启动验证；不发布。
- [x] 默认 `npm run dev` 构建桌面并启动服务；readiness 后只打开一次桌面，自动配置本地连接；`dev:all` 保留为别名。
- [x] 独立开发 profile、单实例复用、桌面独立退出；仅后端/Web 使用 `dev:web`，单独桌面保留 `desktop:dev`。
- [x] 修复 Windows 隐藏启动参数，新增可见窗口回执；进程创建不再等同于窗口打开。
- [x] 25 项 supervisor/launcher/restart 单测、直接 detached spawn 的真实 Electron launcher、真实 Nest/Web/Electron 组合启动通过。
- acceptanceCriteria: AC25；健康前不启动桌面，健康恢复不重复启动，实际窗口与 Web 使用同一本地平台。

### T16 按红框截图精简桌面（AC26）

- [x] 仅修改桌面 SessionSidebar、SessionWorkspace 和 task-workspace.css，移除侧栏管理/搜索、顶部操作及计划/Token 区域。
- [x] 移除隐藏搜索条件的过滤影响，保留任务分类、工作流 Tab、确认卡目录入口和窄屏侧栏切换。
- [x] 同步现有双端展示与工作流冒烟入口；构建及验证证据见 Checklist AC26。
- allowedPaths: 桌面 renderer、既有相关测试、原 SDD 与桌面使用说明；禁止修改 Web 产品组件/样式、业务合同和后端。

## 3. 依赖关系

追加 T19 / AC29（已实现）：增加 `scripts/dev-local-runtime.mjs`，在 `dev-all.mjs` 命令入口启用后端就绪后的已有设备自动连接；独立进程、平台匹配校验、在线复用、进程锁和有界启动反馈。保留 `AGENT_CLUSTER_DEV_AUTO_RUNTIME=false` 开关。新增 launcher 单测并扩展 supervisor 时序测试，实际打开桌面、确认原 Runtime 的 4 个目录保持绑定及设备在线；不重启用户后端或执行模型任务。

追加 T20 / AC30：实现 completion-notifications 主进程轮询与事件筛选、原生通知、平台切换清理；扩展受限 IPC/类型合同，桌面 AppShell 使用 Router 接收点击事件，连接设置提供开关与测试入口。新增单测和独立 Electron 冒烟，分别验证去重、重新执行、错误/取消过滤、失败补查、隐藏窗口及点击回到对应会话；不修改 Web 展示或后端接口。

T19 补充：`scripts/dev-restart-server.mjs` 在确认新后端健康后复用自动连接 launcher；补充助手已退出、仍在运行、启动失败以及后端未就绪四类回归。

追加 T18 / AC28：修复两端跨窗口同步。共享 composable 负责前台恢复、周期补查和关键事件刷新；两端页面仅接入对应数据刷新回调。共享 Session store 保护迟到响应，状态归一化比较服务端时间。验证连接仍为 connected、终态后另一端恢复、请求竞态、后台暂停轮询及完整清理，并用隔离页面样本模拟另一端修改后回焦刷新。范围：共享前端状态/工具、两端工作区接入、相关测试和 SDD；不修改后端数据，不自动启动/停止用户任务。

追加 T17 / AC27：在共享 UserInputBox 中实现输入框上方的任务状态，公共纯函数校验当前会话、连接、最近进度、失败/重试与终态；两端共用实现。验证正常提示位置、完成后清除及连接/过期/异常分支，分别构建 Web 和桌面。修改范围为共享输入框、状态工具与测试、既有双端冒烟及原 SDD；不修改后端队列或流程执行行为。

```text
T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8
```

为避免共用组件和合同交叉改动，默认顺序实施。代码开发依据用户后续“根据这四个文档进行开发”的明确授权；不包含提交、部署或外部通知授权。

## 4. 验证命令与退出规则

逐项追踪如下；T0 提供全部条目的基线，T7 执行集成验收，T8 复核最终证据。

| 验收项 | 直接实施任务 |
| --- | --- |
| AC01 | T1、T3 |
| AC02 | T3 |
| AC03 | T1、T2 |
| AC04 | T1、T2 |
| AC05 | T1、T2 |
| AC06 | T1、T2、T4 |
| AC07 | T4 |
| AC08 | T4 |
| AC09 | T4 |
| AC10 | T5 |
| AC11 | T1、T5 |
| AC12 | T5 |
| AC13 | T6 |
| AC14 | T6 |
| AC15 | T1、T3、T5、T6、T7 |
| AC16 | T3、T7、T8 |

已有命令（实施时按修改范围选择，记录实际输出）：

```powershell
npm run test --workspace @project/web
npm run test --workspace @agent-cluster/shared
npm run test:e2e:browser-collaboration-task-board
npm run test:e2e:browser-brief-revision
npm run test:e2e:rework-loop
npm run test:e2e:chinese-copy
npm run typecheck
npm run test:harness
npm run build
```

Shared/server 有改动时补充对应模块定向测试；新工作区浏览器场景命令为 `npm run test:e2e:codex-task-workspace`。浏览器模拟数据用于稳定状态组合；真实本地测试链路用于验证确认、版本冻结与产物查询，二者证据分开记录。

如果历史文件内容不足、缺运行快照、目录身份来源不明，回到 T0/T1 补齐证据或合同，不能跳过后端只实现表面 UI。功能验收未通过不勾选对应任务；不得沿用旧交付的测试数字。

## 5. 实施记录（2026-09-11）

| 任务 | 已实现与证据 | 剩余 |
| --- | --- | --- |
| T0 | Plan 第 12 节记录发布快照、数组/分页合同、历史内容缺口、权限基线与性能阈值 | 未保留本次改造前的专属截图，不能补造 |
| T1 | shared 合同、运行读取、目录读取、基线、请求隔离、任务选择/草稿/阅读锚点刷新恢复 | 独立 WorkItem 自动分流新 Session |
| T2 | 只读目录、搜索/刷新/预览、明确版本二次确认、服务端 Brief 校验与幂等 | 实际共享部署需启用作者 token 策略，当前 `.env` 未修改 |
| T3 | 240px/自适应/340px 三栏、真实运行三 Tab、项目/工作区分组、窄屏开关、旧管理/审计入口 | 原生 Windows 缩放验收 |
| T4 | 固定快照 VueFlow、真实 attempt 与返工覆盖线、节点任务/Agent/日志/验收/产物/审批历史 | 当前引擎支持的流程定义仍是既有线性规范化，未新增分支执行语义 |
| T5 | 全局只读 Diff、左右/行内、行号、文件切换、引用/重命名降级、历史累计连续性校验 | 旧运行缺完整证据时不可恢复；非原子文件系统基线的限制见 Plan |
| T6 | 中央唯一需求确认卡、右侧只读、同 ID 定位、pending 去重、不抢视图、关闭取消迟到 Diff 请求 | 断线/乱序边界依赖事件连接回归，未宣称所有原生场景已测 |
| T7 | 新浏览器主链路、Web 单测、server 定向测试、原返工冒烟 | 逐条状态见 Checklist；模拟文件显示与真实服务结果分开 |
| T8 | 四件套实施状态与合同/地图回填 | 总体验收仍有未关闭项，不能标成全部完成 |

新增主要文件：`components/workspace/*`、`stores/taskWorkspace.ts`、`stores/historyDiff.ts`、`workflow-file-history.service.ts`、`workflow-authoring-policy.ts`、`tests/e2e/codex-task-workspace-smoke.mjs`。现有壳、群聊、Agent 面板、session/event/workflow stores 和 workflows/sessions 控制器按上述范围集成。未提交、未部署，保留仓库其他既有改动。

测试运行日志在 `.tmp/codex-workspace-*.log`；可分享截图在 `output/playwright/codex-task-workspace/`。冒烟脚本会重建公共 dist，因此与其他会重建的冒烟脚本顺序执行，避免不同服务/构建指纹互相干扰。

## 6. 桌面交付实施记录（2026-09-11）

- T9：在原四件套追加 SPEC-011–016、AC17–22 和 T9–T13，保留旧工作区未验项。
- T10：新增 `apps/desktop`，main/preload 受限接口、本地协议资源、按平台 session 的 API/SSE 代理、连接设置；Web 新增 `/desktop` 及环境适配，桌面隐藏并拦截流程编辑。Cookie、localStorage、sessionStorage 按 origin 隔离，平台配置原子写入用户目录。
- T11：utilityProcess 打包复用 helper；设备码授权、状态、托盘/单实例、忙闲停止握手；传输层可选生命周期统计覆盖异步消息和 invocation，并聚合重连前仍未清理的活动。窗口隐藏不停止助手；已允许退出后不再接受新的助手启动。
- 桌面真实执行发现 Node 24.20.0 的 `fs.cp(errorOnExist)` 拒绝已有临时目标目录（EEXIST）。`runtime.ts` 改为在专属临时容器内复制到尚不存在的 `workspace` 子目录，仍清理整个容器；不放宽文件覆盖策略。原 Node 单测和 Electron 真实进程/ChangeSet 写回回归均通过。
- T12：生成 `output/desktop/Agent-Cluster-Setup-0.1.0-x64.exe`（112,387,302 bytes，NotSigned）及对应 win-unpacked 应用。更新代码接入 electron-updater，默认本地包不启用源；正式包要求 HTTPS 发布目录、发布者、证书和实际签名。没有发布/上传/部署。
- T13：桌面 7 tests、本地助手 81 tests、Web 239 tests、桌面 typecheck/build 和 Harness 通过；真实 Electron 开发入口及 `packaged:true` 程序均通过隔离平台、设备码、真实 stub 进程、忙时停止拒绝、ChangeSet 写回、关窗保留、存储隔离、重启恢复。包内 main/preload/worker 与最终 dist 字节一致，不含仓库 `.env`。

全仓库 `npm run typecheck` / `npm run build` 在 server 阶段失败：既有未提交的 `persistence.service.ts` 同时 import 和本地声明 `SESSION_KEYED_COLLECTIONS`（TS2440）。本次没有编辑该文件，也没有将过去全仓库通过的记录复用为本次通过。桌面构建独立通过，不依赖构建后端。

证据：`.tmp/desktop-{unit-tests,local-runtime-tests,web-tests,electron-smoke,packaged-smoke,typecheck,all-build,build,package,harness}.log`；截图 `output/playwright/desktop/`。打包使用 Node 24.19.0，Electron 44.3.0 内置 Node 24.20.0。安装/使用/更新说明见 [桌面应用运维说明](../devops/desktop-application.md)。本地包可交付测试；生产签名分发、真实旧版升级及干净 Windows 安装/卸载验证仍未完成。
