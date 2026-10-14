# 跨会话切换稳定性与性能 Checklist v1

日期：2026-09-29。状态：部分实现和自动化验证已完成；阅读位置恢复失败，整体未通过验收，不能发布为完整修复。

入口：[Spec](../product/session-navigation-performance-spec-v1.md) | [Plan](../design/session-navigation-performance-plan-v1.md) | [Task](../implementation/session-navigation-performance-tasks-v1.md)。

## 1. 验收记录规则

- 每项填写实际命令、构建/客户端版本、fixture、预期与实际、结果和证据路径；`待执行`、`失败`、`阻塞`、`跳过`、`通过` 必须区分。
- 诊断基线不能作为修复证据。本文创建不代表卡顿、竞态或群聊回归已解决。
- 证据写入 `output/playwright/session-navigation/`，仅保存匿名 fixture 和计时/计数；不保存用户凭据、完整业务源码或真实提示正文。
- 原始用例必须先失败再修复；禁止放宽断言、屏蔽错误、丢弃历史或关闭业务能力得到通过。
- 下列 AC 以第 6 节开发证据补充状态；未经完整验证不标记通过。

## 2. AC—任务—测试追踪矩阵

| 验收项 | 任务 | 测试步骤与通过条件 | 结果/证据 |
| --- | --- | --- | --- |
| SN-AC01 | T04、T09、T10、T31 | 点击 A→B→C，记录组件 mount/unmount；会话导航额外挂载=0。重复选择、query 切视图、直接链接、前进后退、新建/归档/删除后的选择均正确；其他管理页保留状态隔离 | 待执行 |
| SN-AC02 | T05、T07、T08、T11、T31 | B GET 延迟 1200ms 后选 C；再测 A→B→A 乱序。让旧 promise 成功、失败和 finally 分别执行；路由/选择/面板/busy/error/连接都只属于最新轮次 | 待执行 |
| SN-AC03 | T01、T06、T07、T16、T23 | 单独调用读取/缓存刷新不激活；同会话乱序返回不回退。列表刷新结束不能解除切换 busy；所有旧 loadSession 调用有明确归类和处置 | 待执行 |
| SN-AC04 | T13～T17、T31 | A 发消息/确认/修订/上传后切 B，延迟回执只更新 A；不抢 B 的连接、草稿、忙碌和错误。调用次数不增加；未知结果不自动重发。mock 后台继续完成，状态和产物可在返回 A 后看到 | 待执行 |
| SN-AC05 | T14、T17～T19、T26、T31 | A/B 各填写不同文本、4 图片/4 文件（沿用已有上限）、一个 `/` 与 `@`，往返恢复；已提交不被导航取消，未提交确认仍 pending。新草稿不被旧成功清空；授权不会因会话导航取消 | 待执行 |
| SN-AC06 | T02、T11、T12、T31 | 每标签页活动展示 SSE ≤1；旧 cleanup 不关新流。注入断线、重复/迟到事件，补齐结果一致；COMPLETED/FAILED/CANCELLED 保留最终同步，不因切换调用暂停/取消/恢复接口 | 待执行 |
| SN-AC07 | T09、T12、T20、T21、T23 | 首次 bootstrap 后普通切换无全局目录/availability 重初始化；同资源在途 GET ≤1；焦点/定时/网络恢复与首轮不重复。跨会话读不误共享；版本升级门禁、权限/执行前校验仍有效 | 待执行 |
| SN-AC08 | T25～T28 | rAF 合并计数；底部跟随无全历史节点扫描。200ms 节流与离开最终保存生效；图片/文档/流式增高、窗口调整不跳读，旧恢复不作用于新会话；稳定后无持续 observer 循环 | 待执行 |
| SN-AC09 | T02、T23、T27～T29、T31 | 1571/5000/10000 事件下挂载范围只在可视缓冲区及焦点固定项。大单条内容受控，复制和引用定位完整；同一确认/Agent 状态不随滚动变化；键盘操作、标签与焦点不退化 | 待执行 |
| SN-AC10 | T21、T22、T24、T29、T30 | 不可见文档无主动读取；hash 改变更新正文，取消可重试。淘汰后游标/完整性正确重建，pending 操作与草稿不丢；桌面只读取选中运行详情，旧详情不覆盖新选择 | 待执行 |
| SN-AC11 | T05、T10、T19、T31、T35 | 404、超时、断网、版本不兼容、用户显式重试和主动取消分别验证；旧错误不污染 C，不展示 A 却操作 B，不自动执行或重放任务 | 待执行 |
| SN-AC12 | T30、T31、T34、T35 | 正式 Web 与实际 Electron renderer 均验证共享 Store、输入、滚动、任务详情；各自布局保留。diff 无 Server/DB/Runtime 执行业务变更，无新后端合同 | 待执行 |
| SN-AC13 | T03、T32 | 按第 4 节冷/热基准达到 Spec 阈值；采样不含人为延迟，保留真实滚动/文档功能；每组至少 30 个有效样本 | 待执行 |
| SN-AC14 | T03、T24、T33 | 固定集往返至少 30 次，流/监听器/计时器无累计增长；记录固定集及超出缓存容量的第二组。缓存条目/字节按预算淘汰，堆与进程内存分别报告，不把一次 GC 波动当泄漏 | 待执行 |
| SN-AC15 | T03、T33 | 页面与 CPU/内存/可用的系统计数对时；记录鼠标仅浏览器交互迟钝还是跨窗口光标停顿。无法复现或缺少系统证据写明，不能无依据宣称整机恢复 | 待执行 |
| SN-AC16 | T01、T35、T36 | 保留原有 diff；文档与实际行为一致；全部失败/跳过披露，有回退说明。未授权不重启服务/Runtime、不发布、不操作真实任务 | 待执行 |

## 3. 必须独立覆盖的交叉时序

- [ ] C 先返回，B 后返回；B 后报错；B 的 finally 最后执行。
- [ ] A→B→A，第一轮 A 的响应在第二轮 A 之后返回。
- [ ] A 发送成功时正在看 B：A event 写入正确，B SSE owner 不变。
- [ ] A 确认多步操作在 await 中切 B：后续命令仍使用原确认/修订 ID。
- [ ] A 消息发送中又编辑新草稿，再切 B：旧成功不清空 A 新草稿。
- [ ] A 上传/图片识别未完成切 B：附件只回到 A；导航不回收在用 URL/File。
- [ ] A 处于 EXECUTING、WAIT_USER_CONFIRM、PAUSED、COMPLETED 时分别切换；不改变后台状态。
- [ ] 控制状态读取失败时，不能沿用过期许可放行执行/恢复/写回。
- [ ] 离开工作台管理页面再返回，旧 observer/timer/连接不复活。
- [ ] 一次业务操作的迟到刷新不能把新 navigation epoch 递增或把目标设置成原会话。

## 4. 性能基准协议

### 环境

记录：时间、OS、CPU/内存、浏览器/Electron 版本、视口、是否有 CPU 限速、Web 构建标识、后端版本、fixture hash、空闲 CPU/内存和其他负载。比较时使用同机器同正式构建方式；浏览器 DevTools/CPU profiler 不持续开启，分析 trace 另采样，避免混淆计时。

允许使用匿名同规模 fixture；真实会话仅只读且不泄露内容。渲染性能可以使用相同协议的隔离 fixture 响应；业务连续性必须另用隔离后端和 mock Runtime 验证，不能仅靠拦截 POST 声称后台正确。

### 时间标记

- `switch_input`：页面收到侧栏选择/导航意图，携带 client/session 别名与 epoch。
- `switch_feedback`：下一次绘制已反映目标高亮或对应目标加载态。只算反馈，不算 ready。
- `switch_ready`：有效轮次目标基础数据及当前控制/事件补齐已提交，第一帧消息窗口或真实空态绘制完毕；不能以仅更新 URL、显示 skeleton、隐藏按钮代替。
- `switch_settled`：ready 后观察 2 秒，捕获文档响应、尺寸变化及迟到回调造成的后续阻塞。
- 冷切换：目标客户端详情/事件/派生缓存均不存在，应用壳层已启动；不是把整个应用启动时间混入导航。
- 热切换：目标完整数据已缓存；重建游标缺失的会话不能标成热缓存样本。
- 正常性能测量不注入延迟；1200ms 延迟属于正确性用例，单独报告。
- 每组 ≥30 次，前置预热过程不计样本；P95 使用排序后 `ceil(0.95*n)` 的一基下标样本。取消的导航单独统计，不混入成功 ready 分位数，也不能隐去取消过多的情况。
- 所有计时日志只含 ID 别名/epoch、计数和时长，不记录消息正文、附件内容或凭据。

### 阈值与结果模板

| 数据组 | 模式 | n | 反馈 P95 | ready P95 | 最大长任务 | 重挂载/重复请求 | 结果 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 174↔332 | 冷/热分别记录 | 待填 | ≤100ms | 冷≤800ms；热≤300ms | ≤200ms | 0/0 | 待执行 |
| 174↔1571 | 冷/热分别记录 | 待填 | ≤100ms | 冷≤800ms；热≤300ms | ≤200ms | 0/0 | 待执行 |
| 5000/10000 | 压力，冷热分开 | 待填 | 报告实测 | 报告读取/派生/展示分别耗时 | 报告实测 | 有界挂载、无重复执行 | 待执行 |

补充记录：API 耗时、布局/样式耗时、挂载消息数、DOM 数、滚动同步次数、各资源请求计数、正文缓存字节、JS 堆、renderer 进程工作集。不要把 CPU 单核占用比例写成整机占用，也不要把 scroll 累计耗时与包含它的长任务直接相加。

资源测试在固定集第 1/10/20/30 次稳定后采样；另测超过 3 个可重建缓存会话的淘汰。对比保留对象/监听器/缓存统计，不以工作集未马上下降直接判泄漏；受 pending 操作保护的数据独立统计。性能门槛未达标就记录失败，不用修改 fixture 隐藏问题。

## 5. 验证入口

### 文档生成阶段

- [x] 四份文件、相对链接和 README 索引可解析。
- [x] SN-AC01～SN-AC16 在 Spec、Task、Checklist 中完整追踪，T01～T36 无重复、缺失或不存在的依赖。
- [x] 代码证据与计划接口区分；新增脚本标记“拟新增”；没有把开发任务/业务验收勾成已完成。
- [x] 仅本次文档通过范围内 whitespace 检查，未动业务源码。
- [x] `npm run test:harness:phase1` 结果已记录；这只验证基础 Harness 文档规约，不代替本专项功能验收。

### 开发阶段（以下本轮未执行）

在仓库根目录运行；先审查 E2E 启动/清理脚本，确认使用独立数据目录与端口，不挂真实模型和用户会话：

```powershell
npm run test --workspace @project/web
npm run typecheck
npm run build
npm run test:desktop
npm run test:e2e:workspace-chrome
npm run test:e2e:codex-task-workspace
npm run test:e2e:client-presentation
npm run test:e2e:chinese-copy
npm run test:harness
```

拟新增专项在 T03/T31 创建并确认隔离参数后执行；当前不能假定脚本已经可运行：

```powershell
node tests/e2e/session-navigation-switch-smoke.mjs
node tests/e2e/session-navigation-performance-smoke.mjs
```

专项单测覆盖 `useSessionSwitch`、session 导航/业务回调、event connection、workspaceUi、ChatScrollArea、UserInputBoxComposer、文档加载和虚拟窗口。桌面 `test:desktop` 不包含全部 renderer 验收，T34 的实际 Electron 证据不可省略。

## 6. 证据与交付记录

### 文档阶段实际记录

2026-09-29，本轮仅新增四件套并补充 `docs/README.md` 入口，未修改业务源代码，未重启服务或操作真实群聊。使用项目地图、Harness 协议、现有 UI/事件合同及前述源代码/诊断作为依据，采用 plan-work/docs-sync 组织追踪与目录。

| 检查 | 实际结果 | 边界 |
| --- | --- | --- |
| PowerShell 只读校验：文件、相对链接、代码围栏、尾部空白 | 通过：四份文档及入口链接有效 | 包含未跟踪新文档，不仅检查 Git 已跟踪 diff |
| 任务与 AC 校验 | 通过：36 个唯一任务、依赖均指向已定义的前置任务，16 个 AC 在 Spec/Task/Checklist 中可追踪 | 不表示任务已实施 |
| `git diff --check -- docs/README.md` 与四份文档路径 | 通过；README 有 Git 的 LF/CRLF 提示，无 whitespace 错误 | 未覆盖或修复仓库其他用户差异 |
| `npm run test:harness:phase1` | 通过：19/19 文档、172/172 检查 | 验证既有基础协议/模板，不验证本专项业务行为 |
| typecheck、业务单测、build、浏览器/Electron 性能 | 本轮未运行：仅生成文档 | 实现后按本清单执行 |

上述为文档创建时的历史记录；随后实现情况如下。

### 开发阶段实际记录（2026-09-29）

已按用户后续授权修改 Web/共享 Store/桌面 renderer，未修改本专项之外的 Server、DB、Runtime 业务代码；工作区原有其他修改保持不动。使用 bug-triage 建立失败回归，Vue UI/可访问性规范约束焦点及状态展示，docs-sync 同步本记录。

已落地的主要实现：

- `useSessionSwitch.ts`：epoch、只读取消、最后选择生效、独立 loading/error/ready、失败显式重试。
- Web AppShell 稳定工作台 key；双端侧栏先导航，由唯一监听加载；普通切换不重复全局初始化。管理页不再隐式激活会话。
- session Store 拆读取、刷新、激活；16 处确认/修订/恢复等旧 `loadSession` 调用改只刷新原会话。发送、确认、修订忙碌状态按原会话管理，确认处理固定快照，写操作不使用导航 AbortSignal。
- 双端业务回调不能为非当前路由接管 SSE；旧终态 finally 不能关闭新的同 ID 连接；周期同步增加代次和导航忙碌检查。
- 输入草稿、Skill/Agent tag、附件本地引用分会话保存；识别重试迟到结果回原草稿。导航关闭未提交修订弹窗但不取消真实任务或工作区授权。
- ChatScrollArea 单帧调度/200ms 位置写入节流；底部不扫描消息。双端接入动态高度窗口及焦点行保留，大正文支持分段显示和完整复制。
- 文档按可见消息读取、hash 键缓存；正文缓存预算 16MiB/3 会话。事件和详情缓存按最近 3 会话管理，保护当前会话、在途读取和已跟踪写操作；淘汰同步移除 cursor，迟到回执标记历史不完整。
- 空增量保留事件/消息引用；工作流目录在途去重、历史已处理卡不重复读取目录；桌面执行详情仅读取所选 run。

调用归类（T01）：

| 类别 | 修改后入口 | 边界 |
| --- | --- | --- |
| 导航激活 | 双端 `navigation.select` → `sessionStore.loadSession(context.sessionId, context)` | workspace 的常规加载仅此入口；Store 保留兼容签名用于测试/旧调用，不代表业务回调可使用 |
| 缓存刷新 | `refreshSessionCache`、`refreshCurrentSession`、`refreshSourceSession` | 不选择其他会话；写后详情强制新读取，避免复用写入前旧响应 |
| 业务回调 | confirm/revise/member/workflow/permission/writeback/pause/resume 等 | 原请求继续；不调用导航 loadSession；完整组合 E2E 仍不足 |
| 页面连接 | `syncSessionEventConnection`、终态派生、周期同步 | 先检查当前会话/路由；generation 保护释放；单元覆盖重连与 ABA |
| 创建/删除/归档 | 创建返回数据后导航（原轮次仍有效才跳转），侧栏选择走 router | 删除/归档完整浏览器组合验收待补 |

| 检查 | 实际结果 | 证据/限制 |
| --- | --- | --- |
| 最初失败回归 | 已复现：A 确认完成后错误将 B 切回 A；修复后通过 | `apps/web/src/stores/session-navigation.spec.ts` |
| 导航与共享组件测试 | 最近一次 Web Vitest 427 passed / 0 failed（包含配置中的桌面组件测试） | `output/session-navigation-vitest.json`；不等于真实 Electron renderer 验收 |
| 路由实例/历史 | 实际 Router 挂载用例通过：工作台不重建，管理页独立 | `session-navigation-lifecycle.spec.ts` |
| 类型检查 | `npm run typecheck` 通过全部 workspace | 包含 server/shared/local-runtime/desktop/web；桌面脚本的类型检查不覆盖实际交互 |
| 构建 | Web 正式构建通过；桌面构建通过一次 | Web 后续重建通过；桌面在最后几处共享组件调整后尚需重建复验；构建包体告警仍存在 |
| Harness | `npm run test:harness:phase1`：19/19、172/172 | 协议门禁，不证明业务验收 |
| 隔离浏览器导航 | B 的 GET 延迟 1200ms 再选 C，无跳回；输入框保持同一 DOM 实例 | `session-navigation-performance-smoke.mjs`；匿名 API 全拦截，无真实后端写入 |
| 早期 30 次采样 | 正式 Web + 模拟 API，暖切换 P95 约 158.3ms；1 万事件挂载约 10 行，无 pageerror | **早期构建观察值**；随后新增严格锚点验收失败，不得作为最终性能通过证据；原报告可能被后续短跑覆盖 |
| 后续发送切换冒烟 | 隔离脚本执行到锚点断言前，已通过 A 发送后切 B、只发一次、保留幂等键与 B 草稿的断言 | 整条脚本仍失败，不标全通过；尚未覆盖所有确认/上传/修订组合 |
| 阅读锚点 | **失败**：长会话 C 中部切出再返回，同消息视觉位置仍偏移约 26px；阈值保留 <4px | `output/playwright/session-navigation/anchor.json`；连续针对性返工后仍复现 |
| 差异空白 | 本次相关已跟踪文件 `git diff --check` 无 whitespace 错误 | Windows LF/CRLF 提示不算业务失败；未回退原用户差异 |

**当前暂停点**：阅读锚点同一 Signal 在同一实现/验证链路经过两次针对性返工仍未收敛。遵循 `docs/ai-agent-context/harness-engineering-protocol.md` 的连续返工规则，暂停继续实现并请求用户确认继续专项排查。没有将性能门槛降低，也没有删除失败断言。

继续时的首要工作：定位保存/恢复/ResizeObserver/布局更新的精确时序，先使严格锚点用例通过；随后复跑全量测试及最新双端构建，再运行各组至少 30 次的正式冷热基准。补齐大 diff 分段、选择区复制、业务失败反馈归属、所有写操作组合 E2E、实际 Electron renderer、缓存保护/资源计数与系统光标对时；这些未完成项不能由当前单元测试数量替代。

本地可复现命令（API 全拦截，隔离随机端口；不连接当前运行中的真实群聊）：

```powershell
npm run build --workspace @project/web
node tests/e2e/session-navigation-switch-smoke.mjs
$env:NAVIGATION_SAMPLES='30'
node tests/e2e/session-navigation-performance-smoke.mjs
```

回退边界：当前工作区包含大量既有未提交业务修改，禁止整体 checkout/reset。本专项尚未形成提交或发布包；若需回退，先以本记录文件和逐块 diff 构造仅本专项的反向补丁，保留既有修改，再重验。当前不建议刷新正在操作真实任务的页面来当验收；本轮未重启前后端或 Runtime。

### 开发阶段证据模板

| 时间/构建 | 任务/AC | 命令或操作 | 预期 | 实际结果 | 证据路径/限制 |
| --- | --- | --- | --- | --- | --- |
| 待填 | 待填 | 待执行 | 待填 | 待执行 | 待填 |

### 交付门禁

- [ ] T01 的所有隐式激活/抢连接调用已处置，并附修改后清单。
- [ ] 四件套及 UI 合同与实际实现一致；测试失败/跳过和压力冷载边界已披露。
- [ ] 没有 Server/DB/Runtime 执行语义变更；原用户修改保留。
- [ ] 所有必需 AC 通过；无法解释的全局光标卡顿单独列出，禁止写“全部解决”。
- [ ] 已准备本专项独立补丁/构建回退说明，不使用破坏性工作区回退。
- [ ] 只有获得发布/重启授权后才应用到运行服务；前端刷新前检查未提交/上传操作，不重启后台 Runtime 来掩盖故障。

未通过任一正确性门槛不得以“切换变快”交付；文档检查通过只表示 SDD 文档可用。
