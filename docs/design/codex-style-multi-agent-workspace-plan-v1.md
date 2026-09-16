---
artifact: design_plan
stage: design
producedBy: architect
schemaVersion: "0.1"
status: ready
deliveryId: codex-style-multi-agent-workspace-v1
createdAt: 2026-09-11T00:00:00+08:00
intentContractRef: codex-style-multi-agent-workspace-spec-v1
---

# Plan：Codex 式多 Agent 任务工作区

[Spec](../product/codex-style-multi-agent-workspace-spec-v1.md) · [Tasks](../implementation/codex-style-multi-agent-workspace-tasks-v1.md) · [Checklist](../quality/codex-style-multi-agent-workspace-checklist-v1.md)。

## 1. 目标、假设与决策来源

AC32–33：UserInputBox 增加停止/继续及忙碌、错误属性，独立工作区接原 pause/resume；异步返回不得切回另一会话。SessionsService 暂停时中止消息意图识别并阻止后续自动重试，继续时恢复待处理路由且保留原等待确认状态。LocalRuntimeConnectionService 发送 invocation.cancel 后等待 invocation.result（本地 CLI 在子进程关闭后回传），10 秒内未收敛则 pause 返回未确认；15 秒无回执释放等待但保留未确认登记，阻止续跑，迟到回执只解除该登记、不接收业务结果。Runtime 外层阶段 deadline 覆盖 Provider 重试；StructuredOutput guard 只监督现有 CLI 纠正，不主动发起新模型请求。共享 taskActivity 按调用隔离工具错误，排除 RUNTIME_HEARTBEAT，前端三点仍表达调用进行中。Schema 不变；新增错误字段列表放既有事件 payload，不新增数据库表。

AC31 增量设计：共享 `ChatScrollArea.vue` 只封装消息滚动容器与底部居中控件；两端 `ChatTimeline` 通过 slot 保留各自消息卡片，父工作区传入当前 sessionId、derivedStatus 与连接异常标志。ResizeObserver 观察内容与视口，覆盖同一消息流式增高、卡片展开及隐藏视图重新显示；向上滚动退出跟随，到底或点击控件恢复。使用消息锚点及相对偏移恢复阅读位置，存储按客户端、会话及中央/右侧隔离；切换会话重置恢复状态，卸载释放观察器。即时回到底部避免平滑滚动与流式输出竞争；三点动画遵循 prefers-reduced-motion。运行标记表达会话执行阶段，不替代输入框中基于近期事件的健康提示。

交付 Spec 中三栏、只读流程目录、群聊决策、执行记录和历史 Diff。使用现有 Vue 3 / Pinia / Vue Router / Element Plus / Vue Flow 能力。用户截图定义结构与阅读体验，不宣称复制 Codex 私有实现或像素级 Token。

产品选择已确认，用户已授权开发。内部名称、布局尺寸、查询参数为实施基线，实际落点及差距见第 12 节。原先“图谱就是 collaboration_graph”“先选流程新建任务”“在流程页直接审批”的建议已被本次脑暴结果取代。

## 2. Current State Research

基线：HEAD `6cdbefb91ca863d4985b495d38d0aa784b57695f` 加现有未提交修改；2026-09-11 只读核查。不能将其他修改归入本交付。

| 区域 | 当前证据 | 影响 |
| --- | --- | --- |
| 应用入口 | `apps/web/src/components/AppShell.vue`、`router/index.ts` | Web 保留 92px 功能栏；桌面独立 AppShell 实现任务侧栏 |
| 会话布局 | `SessionWorkspace.vue`、`styles.css` | Web 保留四种模式；桌面独立 SessionWorkspace 实现三 Tab 与右侧状态 |
| UI 状态 | `stores/workspaceUi.ts`、`stores/session.ts` | 当前视图与部分草稿为共享字段，需任务维度隔离 |
| 群聊/进度 | `ChatTimeline.vue`、`AgentStatusPanel.vue`、`CollaborationLogPanel.vue` | 可复用消息归一化，需严格只读的侧面消息投影 |
| 图与执行 | `WorkflowRuntimeView.vue`、`workflowChainModel.ts`、`CollaborationGraphView.vue` | 现有图混有 Agent 链路；不得直接改标题充当版本流程图 |
| 子任务 | `stores/event.ts` 的 taskStates、`modules/tasks/tasks.controller.ts` | 有任务事件投影及按 Session 查询接口，须补精确运行/节点/轮次关联 |
| 工作项 | `packages/shared/src/contracts.ts` 的 WorkItem | 实际是 WorkItem 引用 sessionId，不能按先前概念图反转父子关系 |
| 流程版本 | `modules/workflows/workflows.controller.ts` | 有列表、版本列表、版本详情，也有写接口；列表不等于系统发布目录 |
| 运行快照 | shared 的 WorkflowRun | 已有 workflowVersion、definitionSnapshot、workItemId、briefId；NodeRun 含 attempt 和 relatedTaskId |
| 产物 | `modules/artifacts/artifacts.controller.ts`、`ChatTimeline.vue` | 已有列表/详情及行内差异；完整历史两端与累计快照需另核查 |
| 现有样式 | `docs/design/ui-style-guide-v1.md` | 存在深色驾驶舱和多套蓝色规则，新客户端壳按本计划收敛；Web 编辑器不整体重写 |

## 3. Architecture Constraints

允许后续开发：桌面展示位于 `apps/desktop/renderer/`；`apps/web/src/` 仅维护原 Web 展示及共享业务状态，禁止桌面布局侵入；必要的 shared 展示合同及 workflows/sessions/tasks/artifacts/events/persistence/workspaces 的查询、版本证据补齐；相关测试和合同文档。

禁止：改写现有历史记录、用 Agent 名称推断流程、删除 Web 编辑能力、为省事暴露客户端流程写权限、修改 Runtime 选择/质量返工业务算法、未经授权执行外部发布或通知。桌面安装与更新代码纳入第 11.1 节扩展范围。

不变量：服务端业务状态权威；一个视图切换不产生 mutation；运行绑定不可变流程版本；文件对比绑定不可变两端；所有上下文以 ID 关联；审批统一使用现有合法确认操作和幂等机制。只读 UI 不等于后端授权；能力必须在受信服务端范围控制，不能信任客户端传入角色。

## 4. 页面与视觉设计

```text
┌──────────────┬────────────────────────────────┬─────────────────┐
│ 新建任务      │ 任务标题                        │ Agent 进度       │
│ 任务分类      │ 群聊消息(n) / 流程图 / 工作流详情 │ 或只读群聊       │
│ 项目          ├────────────────────────────────┤ 或节点任务列表   │
│   任务记录    │ 当前视图                        │ 或执行详情       │
│   历史记录    │ 群聊时底部输入                  │                 │
└──────────────┴────────────────────────────────┴─────────────────┘
                 点击文件 → 统一 Diff 弹窗
```

建议桌面初始宽度：左 240px、右 340px、中央自适应，标题行 44px、Tab 40px；群聊正文最大约 800px，流程图与详情使用中央全宽。面板独立滚动。新壳保持中性色与低装饰，主操作/焦点沿用 `--el-color-primary`，不扩大为全蓝背景。

| Token | 建议值 |
| --- | --- |
| 正文/密集文字 | 14px / 13px，Segoe UI、Microsoft YaHei、sans-serif |
| 正文/次要可读文字 | #303133 / #606266 |
| 背景/表面/边界 | #f5f7fa / #ffffff / #e4e7ed |
| 控件/面板圆角 | 4px / 6–8px |
| 间距 | 4、8、12、16、24px |
| 强调色 | #409EFF；小字号文本另验证对比度，必要时使用更深文本色 |
| 状态 | 文本+图标+状态色，返工与失败分别表达 |

尺寸是实现建议，视觉验收时调整。1280px 以上默认三栏；1024px 优先将左侧收为可打开抽屉，给流程与右侧任务留空间；更窄 Web 窗口使右侧可打开，所有功能仍可访问。不能沿用直接 display:none 且无恢复入口的规则。Windows 100%/125%/150% 缩放需真实验收，浏览器 deviceScaleFactor 不能单独冒充操作系统缩放验证。

## 5. UI 状态与导航

建议前端语义使用 `chat | flow | workflow_details`，右侧独立使用 `agent_progress | chat_readonly | node_tasks | task_detail`。这是前端视图状态，不加入后端执行状态机。

在 `/workspace/:sessionId` 保留查询参数路由，按当前任务附加必要的 workItemId、runId、nodeId、taskId、attempt；切换只更新合法选择。旧 `view=workflow` 按既有运行画布意义兼容到流程图；旧 collaboration_graph 不可直接等同新流程，明确兼容跳转并保留原功能可达入口。debug 收入详情审计入口，保留旧链接可解析。最终兼容映射在 T1 用路由测试固定。

是否有工作流以运行记录/快照为主、相关事件为补充；不能只判断 status=running、不能由当前一页消息数量决定。加载状态与无运行状态分离，首次运行出现只增加 Tab，不抢切群聊。选择多个历史运行时图与详情共用 selectedRunId。

节点选择在 flow 内切换右侧；返回群聊清除节点覆盖，显示 Agent 进度。进入详情默认右侧只读群聊。单 Agent 节点也允许通过同一列表进入详情，减少两套交互。右侧返回按钮可先返回列表，“关闭节点详情”恢复只读群聊。

草稿与视图位置按 sessionId/workItemId 隔离；节点和任务选择额外按 runId。过期请求忽略，删除/失效对象回到合法空态。弹窗打开后保存来源和焦点；通知不动弹窗。手动切换任务时关闭或隔离旧弹窗，不把旧文件标成新任务文件。

## 6. 需求确认与只读流程目录

复用现有 Brief、确认卡与 Session 操作：澄清→需求确认→选流程→启动。系统判断需求充分性，客户端仅呈现状态。需求内容修订后须关联新的确认版本；旧确认不能为新需求启动运行。

客户端目录读取系统发布且当前用户可用的流程，支持刷新/增量失效提示。优先复用后端已有事件和查询，不因为“推送”一词新增消息中间件。无有效任务只预览；未确认需求显示“先确认需求”；已启动运行显示当前绑定，不在这里替换。

绑定流程时显示用户选中的具体版本；启动请求复核需求确认状态、版本可用性、所有者与幂等键。版本变动不得静默换到最新版。启动成功读取 definitionSnapshot；以后目录更新、归档不改变既有运行快照。

只读目录使用独立视图（建议 `WorkflowCatalogView`），不挂载 `WorkflowManager` 的编辑工具栏。Web 作者侧保留原编辑器；使用环境能力区分入口，同时服务端保证普通客户端身份无法调用写定义操作。具体发布范围与角色来源在 T0 核查后写入 API 合同。

## 7. 执行数据模型

新增客户端任务使用现有 Session 和需求 WorkItem ID 组合投影“一需求一任务”，不新增倒置关系表。若现有意图路由会在同会话创建新的独立 WorkItem，客户端与服务端入口须显式适配新任务行为；不能只改左侧标题。旧数据兼容读取，不自动重写。

流程图从固定 WorkflowVersion 的 nodes/edges 生成，叠加 NodeRun 状态、真实返工记录与当前节点。不要复用按 Agent 去重的 chain model 充当节点模型。同 Agent 多节点、人工节点、robot_approval 均按 nodeId 展示。

节点任务查询以 sessionId/workItemId/runId/nodeId/nodeRunId/attempt 为边界；Agent 名称仅显示，不能作为关联键。使用 Task 与 NodeRun/审批记录形成列表、详情和历史。接口缺字段时显式补齐 shared 与查询，不能把整 Session 事件都当当前运行。

## 8. 通知与文件 Diff

通知键优先用 confirmationId，关联 sourceEventId、runId、nodeId、taskId。群聊为唯一决策提交面；其他位置的处理入口统一为导航函数。pending 数量从未解决记录推导，读取通知不清零。重复 SSE 不重复计数；处理失败保持 pending；过期卡片重取状态。消息未加载时按 ID 定位补取，不盲目滚到底。

统一文件查看入口接收来源身份与比较范围，建议形状为 `{sessionId, workItemId?, runId?, nodeRunId?, taskId?, artifactId, fileChangeId, scope: attempt|delivery}`。服务端解析真实路径和版本，避免 UI 自造 before/after 内容作为权威证据。

优先复用真实 ChangeSet/Artifact 的不可变 before/after 引用。缺失时，在执行前后采集必要内容/版本并保存；最终交付使用运行开始基线与确认交付两端，不拼接多轮 patch。记录路径变更、文本编码/二进制状态、内容是否完整。仅有摘要或补丁的旧产物明确降级，不能承诺可还原完整文件。

Diff 弹窗建议左侧变更文件列表，主体左右/行内切换、行号、上下文折叠、新增删除统计；大文件采用按需载入/虚拟化，性能阈值在 T0 依据真实样本制定并记录。只读查看不共享可写修订编辑器的 submit/apply 回调。

## 9. Contract Impact 与技术核查

| 能力 | 现有入口 | 需验证/补齐 |
| --- | --- | --- |
| 流程目录 | GET /api/workflows，版本查询 | 只发布/分发范围、权限、失效版本、分页完整性 |
| 执行记录 | Session workflowRun 投影、WorkflowRun/NodeRun 类型 | 历史运行查询、完整快照、节点与 task/attempt 关联 |
| 子任务/产物 | GET /api/sessions/:sessionId/tasks、artifacts；GET /api/artifacts/:artifactId | 精确筛选、版本化文件内容与累计比较 |
| 需求确认/启动 | Sessions 的 Brief 和流程操作 | 确认修订与选中版本校验、独立新需求入口、幂等 |
| 通知 | Event、Confirmation 投影 | 未解决记录完整性、历史消息定位、服务端状态同步 |

上表列出已观察到的入口而非声称所有目标能力已实现。T0 输出差距，T1 固化合同再开发；确需新增端点时同步 API/Event/UI State/Data 文档及 shared 类型。不得把列表中存在 draft 的既有 API 原样当作系统目录。

## 10. 方案取舍、风险与实施顺序

选择复用领域数据、拆分显示组件；不选择把旧 Agent 图直接改名，因为它不能忠实表示所选流程；不选择新建一套业务执行引擎，因为会使返工、审批与历史分裂。

主要风险：历史 Diff 缺基线；异步任务切换串数据；新通知抢视图；把只读视图误当授权；旧 CSS 隐藏侧栏；旧路由与多 WorkItem 语义不兼容。对应验证见 Checklist。

实施顺序：T0 基线差距→T1 合同/状态→T2 目录与确认→T3 壳和 Tab→T4 运行视图→T5 Diff→T6 通知联动→T7 集成验收→T8 Review。此顺序不构成自动派发多个 Agent 的指令。

## 11. Acceptance Mapping 与 Tests to run

| 验收 | 设计章节 | 任务 |
| --- | --- | --- |
| AC01 | 5、7 | T1、T3 |
| AC02 | 4、5 | T3 |
| AC03 | 6、9 | T1、T2 |
| AC04 | 6、9 | T1、T2 |
| AC05 | 6、9 | T1、T2 |
| AC06 | 6、7、9 | T1、T2、T4 |
| AC07 | 5、7 | T4 |
| AC08 | 5、7 | T4 |
| AC09 | 5、7 | T4 |
| AC10 | 8、9 | T5 |
| AC11 | 8、9 | T1、T5 |
| AC12 | 8、9 | T5 |
| AC13 | 8 | T6 |
| AC14 | 8 | T6 |
| AC15 | 4、5、8、10 | T1、T3、T5、T6、T7 |
| AC16 | 4、5、10 | T3、T7、T8 |

开发后运行 Web 单测、相关 shared/server 定向测试、浏览器主链路、typecheck、test:harness、build。实际命令、结果与限制见 Tasks 和 Checklist。

## 11.1 桌面交付补齐设计（AC17–AC22）

新增 `apps/desktop`：Electron main/preload、独立 utility process 助手入口、受限本地协议、连接设置、生命周期与更新、构建和安装脚本。分别构建 `apps/desktop/renderer/index.html` 与 `apps/web/index.html`，桌面不再复制 Web 的生产入口；复用 Web 中的领域逻辑及构建工具链，以及 `packages/local-runtime-cli`；不启动 `scripts/dev-all.mjs`、不自动启动 Nest/数据库、不占用固定开发端口。

允许路径扩展为 `apps/desktop/**`、Web 桌面适配及连接组件、local-runtime-cli 生命周期观察接口及相关测试、根构建脚本与锁文件、本四件套和运维文档。保留其他未提交修改。新增界面使用现有 Element Plus，保留三栏和无图标任务记录。

Renderer 从 `agent-cluster://app` 加载本地资源，使用同源 `/api` 代理到已配置的平台；保留 SSE streaming，不允许任意目标代理或跳转携带凭据。Node integration 关闭、contextIsolation/sandbox 开启；preload 只公开具名设置/助手/更新操作，主进程验证 sender 与主 frame。API 代理额外阻断流程定义写请求；服务端仍须启用作者权限策略，不能用桌面拦截替代服务端鉴权。

平台地址规范化与现有 helper 相同；不同 origin 使用独立 Chromium session partition 和助手状态目录。更换平台先完成助手空闲停止；不迁移旧设备令牌。连接设置不承担新用户/租户登录体系，复用当前设备码授权和管理员凭据界面。

助手通过 utilityProcess 复用 Electron 自带 Node 环境，应用与助手同版本打包。消息接收、运行中的 invocation 和异步文件操作由助手内部追踪；停止请求在同一事件循环内先封闭接单再判断忙闲，忙则拒绝并恢复接单，空闲则正常断开并等待退出。主进程不得以定时强杀作为成功停止。正常关窗口隐藏，显式退出走相同握手；异常崩溃沿用既有中断语义。

安装采用 electron-builder NSIS x64，构建资源使用固定版本依赖。更新使用 electron-updater，关闭 autoInstallOnAppQuit，发布地址来自打包配置。正式发布脚本要求 HTTPS 更新源和签名配置；默认本地安装包不自动发布。下载与安装分开，安装前握手停止助手；更新失败保留明确错误，不承诺已经实现自动回滚。平台后端升级需向后兼容客户端合同；helper 复用既有协议版本握手。

任务对应：T9 文档/合同→T10 桌面与连接→T11 助手与退出保护→T12 安装/更新→T13 验证。验证覆盖真实 Electron 本地资源、路由、代理/SSE、隔离与只读、进程和更新防护；签名生产升级和干净 Windows 机器独立标记待验，不借用 Web 测试作为桌面通过证据。

## 12. 2026-09-11 实施基线与差距

| 项目 | 核查结果与实现 |
| --- | --- |
| 系统目录 | 新增 `GET /api/workflows/catalog/published`，返回 `{items: WorkflowVersion[], hasMore:false}`，每个可用流程当前已发布版本，不读取未发布草稿名/节点；刷新同步目录 |
| 历史运行 | 新增 `GET /api/workflow-runs/session/:sessionId`；详情返回 `{run,nodeRuns,approvals}`，图从 `run.definitionSnapshot` 读取 |
| 任务/产物 | tasks 的响应 data 是 **数组**；artifacts 的 data 是 `{items,hasMore}`。前端按真实合同适配；任务以 runId/nodeId 与 NodeRun.relatedTaskId 共同关联 |
| 启动 | 复用 Brief 确认与 `/sessions/:sessionId/workflow/select`，补充 `confirmedByUser` 校验及同 confirmation/版本重试幂等，禁止复用确认换版本 |
| 作者权限 | 所有写定义端点检查服务端配置；`WORKFLOW_AUTHORING_MODE=read_only` 全拒绝，`token` 模式必须配置 `WORKFLOW_AUTHORING_TOKEN`，作者端请求提供 `x-workflow-author-token`。未配置模式和令牌时保留既有本地作者行为，**不能声称默认部署已隔离客户端权限**。令牌不写入浏览器持久存储 |
| 工作区状态 | `taskWorkspace` 读取运行/任务/产物，用请求代次丢弃旧响应；运行/节点/任务/轮次 ID、输入草稿和聊天阅读锚点按 sessionId 写入 sessionStorage，刷新恢复；中央/右侧分别保存阅读位置，同页切换保留中央聊天挂载 |
| 文件来源 | `historyDiff` 统一打开 `HistoricalDiffDialog`，本轮读取 Artifact 的权威 ChangeSet；平台待写入内容与只读报告明确标为引用；重命名无内容时仅显示路径变动 |
| 累计文件 | 新增 `WorkflowFileHistoryService`、`WorkflowRun.fileBaseline` 和 `GET /api/workflow-runs/:runId/file-diff`。开始前记录文件哈希，逐轮校验真实 ChangeSet 连续性，按开始/最终内容生成差异；撤销后的改动从累计视图消失 |
| 资源边界 | 基线扫描最多 15 秒、512 目录、1024 文件、单文件 2 MiB/总计 32 MiB；Provider 单调用也受总时限约束。缺基线、分页缺口、缺历史原文、缺轮次证据（包含取消任务）、版本不连续均 unavailable。不是整个文件系统的原子快照，未纳入执行证据的外部写入无法由此证明 |
| Diff 性能 | 文本两端合计最多 1,000,000 字符、12,000 行、LCS 2,000,000 单元；超过上限明确降级，保存内容预览最多 100,000 字符；二进制不生成文本差异 |
| 产品任务 | 新建任务创建新 Session，左栏按真实 projectId/workspaceId 分组。旧 Session 不迁移；既有语义路由仍可能在同 Session 创建独立 WorkItem，自动分流到新 Session 的适配尚未完成，不能仅用改名视作 AC01 全通过 |

桌面组件位于 `apps/desktop/renderer/components/workspace/`；桌面旧 Agent 关系图与执行审计从“更多视图”访问。只有桌面工作区隐藏全局栏、集中群聊审批；Web 保留原导航、四视图与确认卡布局。

回退应按本交付的文件 diff 逐项撤销，不做整仓重置。新增历史基线为可选字段，旧运行返回明确不可用；不能修改旧产物来伪造验收。Windows 原生缩放、共享后端部署权限配置与自动独立需求分流仍需单独关闭验收项。

## 13. 两端界面隔离实现（AC23、AC24）

- Web：`apps/web/index.html → src/main.ts → App.vue → AppShell.vue`；Web router、SessionWorkspace、SessionSidebar 和 styles.css 保持原视觉基线。
- 桌面：`apps/desktop/renderer/index.html → main.ts → App.vue → components/AppShell.vue`；独立 router、工作区/聊天/进度/确认组件、styles.css 与 task-workspace.css。
- `apps/desktop/vite.renderer.config.mjs` 指定桌面 root，build.mjs 对桌面 renderer 单独 vue-tsc 并输出 dist/renderer。两端不靠窗口宽度或 bridge 存在与否来选择工作区。
- 共享层：Web 中 API、stores、types、utils、无外观差异的管理组件；历史差异纯算法位于 `apps/web/src/utils/historyDiffModel.ts`。桌面 CSS 不反向 import Web CSS，Web 不 import 桌面组件或样式。
- 恢复基线按已核查 diff 逐项执行。Web 工作流 Agent 链/配色、日志心跳合并、返工和连接修复等其他未提交改动保留。
- 取舍：两端独立展示组件存在部分重复，换取本次明确的外观隔离；后续通用行为应下沉到 composable/store，禁止通过合并模板重新覆盖 Web。
- 回归：`ClientPresentation.spec.ts` 同时挂载两端列表；`client-presentation-smoke.mjs` 校验实际 CSS、导航宽度、工作流/目录与零写请求；原 Codex 工作区端到端脚本改为加载桌面 renderer。

## 14. 统一开发启动（AC25）

根命令 `dev` 先运行已有桌面构建，再以 `--desktop` 调用 `scripts/dev-all.mjs`；`dev:all` 是别名，`dev:web` 保留仅后端/Web 的启动方式。supervisor 仍负责后端/Web 的进程与健康探针，首次 readiness 通过后调用 `scripts/dev-desktop.mjs`，不会在健康恢复时反复打开桌面。启动失败返回非零结果；停止期间迟到的健康响应不得再打开桌面。

开发 launcher 校验回环后端 origin，使用 `.cache/agent-cluster/desktop-dev-<port>` 独立 profile，原子写入该 profile 的连接配置，再直接启动当前 Electron 二进制。清除 `ELECTRON_RUN_AS_NODE`，使用参数数组，日志写入 profile/desktop.log；同 profile 由现有单实例机制复用窗口。桌面 detached 启动，不加入 supervisor 强制清理的服务进程组；终端退出仅停止后端/Web，桌面仍通过应用菜单安全退出。此能力仅属于开发工具，不改变已安装产品生命周期、Helper 授权或更新策略。

Windows 交互式 Electron 使用 `windowsHide: false`，避免隐藏首次显示窗口。每次启动携带唯一 `--dev-launch-id`；开发模式主进程在窗口展示后或复用窗口后原子写入回执，launcher 仅在回执确认窗口可见、后端匹配时报告成功。错误回执、提前异常退出、20 秒无回执均报错；成功读取后删除回执。打包应用忽略该参数。回归必须包含直接 detached spawn 的真实启动，不能仅以 Playwright 替代进程创建来覆盖 Windows 启动选项。

## 15. 红框区域精简（AC26）

仅在独立 renderer 中移除侧栏管理/搜索模板、中央 workspace-actions、CollaborationTaskBoard 和 TokenUsageIndicator；聊天网格改为消息可伸缩行加输入框自适应行，不能留下空白进度行。侧栏不再读取共享的搜索条件，保留任务分类。窄屏切换按钮从操作栏独立出来，流程目录沿用确认卡 manage_workflows 事件。Web 组件、共享业务状态与后端不修改。

## 16. 输入框上方任务状态（AC27）

两端已经共同引用 `apps/web/src/components/UserInputBox.vue`，本次在这一组件接入 `utils/taskActivity.ts` 纯状态判断。读取当前 Session、同会话 SSE 状态及执行事件，运行阶段且近期有信号才显示运行文案；超过 90 秒无信号改为状态待确认，不据此判定任务失败。5 秒刷新事件年龄，卸载清理计时器，不增加后端请求。提示使用 role=status 与低频圆点动效，遵循减少动画设置；输入框上方预留空间，不改变消息输入和发送语义。后续修改文案/逻辑只改共享实现，但 Web 与桌面仍需分别构建交付。

## 19. 桌面任务完成通知（AC30）

Electron 主进程每 5 秒读取已有会话列表，只对 updatedAt 变化的会话补查事件，使用 afterEventId 增量游标和首次快照时间过滤历史完成事件。请求沿用当前平台的 Electron session 和认证 Cookie，后台不受 renderer 定时器节流。轮询不重叠，失败重试不推进游标；切换平台停止旧 monitor 并丢弃迟到响应。通知使用原生 Notification，Windows 设置与安装包一致的 AppUserModelID，开发使用 Electron 可执行路径。设置存入独立 notifications.json，不被开发连接配置覆盖。点击通过受限 preload 事件交给 Vue Router，避免整页重载丢失任务草稿；旧平台通知不能跳到新平台。

原生样式、右侧位置和勿扰行为由 Windows 控制，不自绘置顶窗口。进程持有最近 100 个通知引用支持通知中心后续点击；更早通知关闭释放。默认不新增服务端模块或 Web 通知权限请求。预计正常网络下约 5 秒内提醒；首轮基线前及应用完全退出期间的完成不补弹。

## 18. 复用已有本地 Runtime（AC29）

开发 supervisor 在首次后端就绪后调用独立 launcher，读取 `AGENT_RUNTIME_STATE_FILE` 或 CLI 默认状态路径，仅恢复相同平台的已有授权。独立 worker 复用 CLI 的状态、token 刷新、WebSocket 重连和工作目录注册实现；状态旁的进程锁避免重复自动拉起，已在线设备直接复用。通过 IPC 收到平台连接回执才报告 connected，超时报告 connecting，异常输出日志。worker 与桌面均不加入 supervisor 强制停止的服务进程组。仅修改开发启动脚本、针对性测试及文档，不修改桌面内置助手、后端业务逻辑或任务绑定。

手动重启入口在验证新 processId 后调用同一 launcher，覆盖旧助手已经退出的情况。助手启动错误与后端重启结果分开报告；使用注入的重启请求、健康响应和 launcher 验证时序，不重启用户真实业务服务。

## 17. 跨客户端状态同步（AC28）

`useWorkspaceSync` 为共享协调逻辑，两端 SessionWorkspace 各挂载一次。focus、visible、online 和关键工作流/任务事件触发 250ms 合并刷新，另有 15 秒前台补查；刷新期间不叠加请求，卸载移除监听和计时器。刷新列表及当前详情后补拉事件、WorkItem、文件修订；桌面额外刷新独立历史 store 的运行/节点/任务/产物。终态也保留页面激活监听，从新快照发现恢复执行后重新建立 SSE。

`resolveSessionStatus` 按服务端时间比较详情快照和状态事件，旧终态事件不能覆盖新运行快照；事件投影保持服务端时间，不使用本机接收时间冒充更新时间。详情刷新校验会话选择代次及期间的新状态，列表合并保留请求期间到达的更新。不修改后端或业务决策，不合并两端样式，不自动选择另一端当前打开的任务。
