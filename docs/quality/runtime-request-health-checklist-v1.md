# Runtime 请求健康与未知等待 Checklist v1

状态：2026-09-29 核心实现已接入，确定性回归与独立双端组件验证已执行；全专项验收仍未完成。以下未勾选的复合场景保留完整门禁，不把部分证据当作全部通过。

依据：[Spec](../product/runtime-request-health-spec-v1.md) | [Plan / 系统开发方案](../design/runtime-request-health-plan-v1.md) | [Tasks](../implementation/runtime-request-health-tasks-v1.md)。

## 1. 验收规则

- 本清单验证目标设计，不替当前运行实例背书，不把旧测试结果移入新专项。
- 每项须填写命令、测试/fixture、环境、时间、退出码、报告路径和关联 Task；实现代码存在不等于验收通过。
- 默认 stub、假时钟、隔离状态和测试数据库；10/30 分钟等待通过假时钟推进，不发额外模型请求。
- 思考模式只是可选信号；正常和未知不因时间预算取消；停止及已批准硬限制保持有效。
- 生产更新、真实模型采样、数据库迁移和服务重启另行批准；文档生成不授权这些操作。

## 2. 需求—任务—验收追踪

下表“部分通过”指第 7 节已有源码/确定性证据，但复合验收仍有未执行部分。RH-AC 完整定义以 Spec 为准；没有一个“部分通过”可以作为上线放行。

| 验收编号 | 要求 | 开发任务 | 最小证据 | 状态 |
| --- | --- | --- | --- | --- |
| RH-AC01 | RH-FR01、02 | T01–04、T07、T12 | 模式独立 reducer/无输出 fixtures | 部分通过；真实 CLI 组合待验 |
| RH-AC02 | RH-FR02、11 | T02–04、T11、T12 | parser/原生身份去重/JSON 与分块 stderr 脱敏 | 部分通过；全链隐私矩阵待验 |
| RH-AC03 | RH-FR01、03 | T01、T02、T04、T05、T11、T12 | 弱信号、probe 绑定/unsupported 定向测试 | 部分通过；完整限流/超时压力待验 |
| RH-AC04 | RH-FR04、08 | T01、T02、T06–08、T12 | 全 10 phase、两 runner 各 3 timer、Generic/Local 观察测试 | 部分通过；全入口故障交叉矩阵待验 |
| RH-AC05 | RH-FR04、05 | T02、T06、T07、T10、T12 | 跨 10/30 分钟及一天 reducer、首帧/静默/非流式测试 | 部分通过；通知压力待验 |
| RH-AC06 | RH-FR06 | T05、T08–10、T12 | wait 版本/幂等/同 ID 与 deadline；Session 全停测试/组件浏览器 | 部分通过；多 Agent 双端贯通待验 |
| RH-AC07 | RH-FR07 | T02–04、T07、T08、T12 | retry 不续期、恢复进展、真实失败、预算耗尽不再请求 | 部分通过；全 provider 错误矩阵待验 |
| RH-AC08 | RH-FR08 | T02、T06–08、T12 | 准入/原 deadline、attempt、纠正 guard 与要求 Token 回归 | 部分通过；Generic 内部请求账本全审待完成 |
| RH-AC09 | RH-FR09 | T02、T05、T06、T08、T09、T12 | 停止/迟到结果/generation/预留与删除生命周期回归 | 部分通过；完整跨进程矩阵待验 |
| RH-AC10 | RH-FR05、10 | T09、T10、T12、T13 | 共用 store/组件；Web/Desktop CSS 的独立浏览器 fixture | 部分通过；打包 Electron/SSE 全贯通待验 |
| RH-AC11 | RH-FR03、11 | T03–05、T11、T12 | 零模型 probe/脱敏/有限缓存与辅助写重试 | 部分通过；资源/隐私压力门禁未关闭 |
| RH-AC12 | RH-FR10、12 | T01、T04、T05、T09、T12、T13 | 实际 file reload、原子 outbox；PG schema/SQL 投影测试 | 部分通过；真实 PG/跨版迁移未执行 |
| RH-AC13 | RH-FR09、12 | T05、T06、T08、T09、T12、T13 | 历史快照无权限、既有停止回执/重启安全回归 | 部分通过；实际 Worker/CLI 更新待验 |
| RH-AC14 | RH-FR04、07、08 | T02、T06–08、T12 | 工具静默不取消、真实错误与纠正额度测试 | 部分通过；批准硬限制组合压力待验 |
| RH-AC15 | RH-FR01–12 | T12–14 | 回归通过；侧栏阻挡经批准修复后整仓类型检查/构建通过，见 V9 | 部分通过；全矩阵/更新门禁未完成 |

## 3. 确定性场景与断言

### 3.1 信号、思考模式与观察阈值

- [ ] C01｜RH-AC01、04：thinking 连续有效增量超过旧 10/30 分钟及 operation deadline，原 invocation 保持执行，平台 cancel=0；过期旧 thinking 不永久续期。
- [ ] C02｜RH-AC01、02：思考关闭，只有正文/参数/工具进展仍 progressing；不要求 reasoning 事件、不修改用户模式。
- [ ] C03｜RH-AC01、05：隐藏思考、无 reasoning delta、buffered 或首个输出迟迟不到，观察到期进入 unknown_wait，cancel/settle=0，保留相同句柄/进程/预留。
- [x] C04｜RH-AC03：弱信号不制造模型进展。纯 reducer 对 transport/ack/probe alive/pending 跨阈值进入未知；CPU/native active 未注册为有效进展。证据 V1、V3。
- [ ] C05｜RH-AC03、11：probe unsupported、超时、未知请求、旧 epoch、错设备/generation/invocation 或重复响应，均不伪造健康/上游失败；只清理 probe，不取消模型。
- [ ] C06｜RH-AC02：两个身份不同但文本相同的合法 delta 均计入活动；同一事件重传/partial 最终回放不重复；空 delta、signature、重复 usage 不续期。
- [ ] C07｜RH-AC02、11：reasoning 原文/签名不出现在 raw frame、stdout/stderr 长期捕获、数据库、审计、API 或 UI；结构化最终输出仍正确保留。
- [ ] C08｜RH-AC04、05：每一个 first-frame/idle/absolute/phase/repair 观察 timer 单独到期，不能出现内层先 abort；未知长等待无隐含 TTL。

### 3.2 真实异常、工具与预算

- [ ] C09｜RH-AC07：一次 502/api_retry 后新进展恢复；重试通知本身不算进展、不立刻永久失败；持续真实错误达到原有界额度后真实失败。
- [ ] C10｜RH-AC07：真实供应商超时/HTTP 终态、TCP/TLS 错误、进程失败准确归类；已结束请求不能伪称仍保留。静默/probe 超时不能包装成 provider failure。
- [ ] C11｜RH-AC04、08：同一 invocation 正常工具轮转及下一内部模型请求可继续；operation deadline、平台 attempt 和已用 Token/费用未重置。结束后新平台调用仍做准入校验。
- [ ] C12｜RH-AC08：预算/尝试耗尽时不新增异常恢复请求；平台无法精确控制的 CLI 内部重试如实标注未知，不能用虚假计数宣称有界。
- [ ] C13｜RH-AC14：普通工具长执行，有真实进展继续、不可核实进入未知；不是用 runtime 心跳给工具续期。实际工具失败及已批准安全硬上限仍终止并给出正确原因。
- [ ] C14｜RH-AC08、14：非法 StructuredOutput 触发一次允许纠正；纠正请求等待超过原 300 秒观察阈值不被误杀；纠正次数耗尽/真实失败仍按合同失败。
- [ ] C15｜RH-AC08：明确配置的 Token/费用/循环/资源硬政策与权限撤回保持生效；旧模型 absolute 默认值不被自动认定为用户批准硬政策。

### 3.3 用户选择、停止与竞争

- [ ] C16｜RH-AC06：点击“继续等待”后 invocationId/进程实例、request 数、attempt、deadline/账本均不变；不调用 resume；重复点击幂等，旧版本/终态返回冲突及当前快照。
- [x] C17｜RH-AC06、09：当前支持会话全停，按钮明确“停止会话全部调用”；RuntimeService 测试取消同会话全部活动句柄并等待结果，组件测试发出原 Session stop。证据 V3、V5、V6；不宣称单 invocation 停止。
- [ ] C18｜RH-AC09：unknown_wait 后合法结果正常应用一次；重复 result/outbox 不重复业务写入。
- [ ] C19｜RH-AC09、13：stop/result、generation 替换/result、probe/stop 竞争，停止后的内容不应用、不复活；迟到结果只能核对可信结束。
- [x] C20｜RH-AC09、13：取消后 process-end 未确认保留屏障，迟到结果仅核对结束、不重发成功；原停止回执/预留/准入回归保留。证据 V2、V3；实际更新/回退另见 C32。
- [ ] C21｜RH-AC05、10：关闭浏览器、SSE 断开或刷新不取消调用；业务 SessionStatus 保持原语义，不被未知改为 FAILED/PAUSED/WAIT_USER_CONFIRM。

### 3.4 存储、兼容、双端与更新

- [ ] C22｜RH-AC10：Web/desktop 都按快照+版本合并 SSE；乱序/旧 generation/旧 epoch 不倒退状态；多 Agent 不因同设备心跳全部判健康。
- [ ] C23｜RH-AC10：健康查询失败显示“观测不可用”，保留已有可信终态；未知→进展→成功/失败时正确收起提示，通知不刷屏，按钮状态/键盘交互一致。
- [ ] C24｜RH-AC12：file/PostgreSQL 保存、读取、备份、replace-state、迁移及 outbox 语义一致；并发版本更新和重复 wait/event 不丢状态或越过停止屏障。
- [ ] C25｜RH-AC12：健康写入/事件保存失败进入受限待同步，不取消健康模型、不重跑；业务结果仍遵守原保存/结束门禁，事件恢复可幂等重放。
- [ ] C26｜RH-AC12：旧 CLI 无 probe/partial 时明确降级 unknown；协议协商失败在启动前拒绝或按已验证模式运行，不静默恢复旧 idle kill。
- [ ] C27｜RH-AC13：server/CLI/Worker 重启后历史 running 记录降为未知，核对 owner/generation/实际进程；PID 复用不会误认健康；不能自动重放模型或取消后应用业务结果。
- [ ] C28｜RH-AC13：控制链路断开与上游静默分别处理；重连绑定原调用/回执，旧进程结束未确认时禁止替代执行；不把 Runtime 掉线直接当模型结束。
- [ ] C29｜RH-AC06、12：跨会话/设备 invocation 请求、未授权用户、缺少/错误版本和幂等键被拒绝；健康查询/wait 无模型或进程创建副作用。
- [ ] C30｜RH-AC11：加速长等待、大量并发未知和大事件下，probe 并发/缓存/刷写/通知有界；结束后计时器/pending/listener 清零；probe 模型调用数始终为 0。
- [ ] C31｜RH-AC11：每个决策能追溯观察层、时间、原因及 policyVersion，日志无凭据/prompt/思考正文；调用 ID 不作高基数指标标签。
- [ ] C32｜RH-AC15：隔离更新/回退演练确认源代码、构建和实际进程版本一致；按 invocation 冻结策略，不热切旧 kill timer，不重跑历史任务，不靠 stale=false 单独判定加载成功。

## 4. 全路径与阶段覆盖门禁

下列每条路径仍须覆盖完整 C03/C08、C09/C10、C16–20 的交叉矩阵。现有单层定向测试只证明表中描述的范围，不等价于每条路径都已贯通这些组合。

| 执行路径 | 观察/计时器 owner | 专项重点 | 状态 |
| --- | --- | --- | --- |
| Local Claude | shared parser、local adapter/process、connection idle、RuntimeService | partial/思考隐藏、设备与调用分层 | parser/Local idle/probe 通过；真实旧 CLI 待验 |
| Local Codex exec | JSONL adapter/process、connection idle、RuntimeService | 无 reasoning/probe 能力的未知降级 | 观察/进程/Local 生命周期回归通过；全故障贯通待验 |
| Server Claude streaming | parser、watchdog、runner、RuntimeService | first-frame/idle/absolute 全部转观察 | 三 timer 分别观察后晚成功/用户取消/真实失败 stub 通过 |
| Server Claude buffered | adapter/process runner、RuntimeService | 无输出时保留，不受另一 absolute kill | execFile timeout=0 与监督回归通过；完整矩阵待验 |
| Server Codex streaming | app-server parser、watchdog、RuntimeService | reasoning 活动、active 弱证据、终态 | 三 timer 分别观察后晚成功/用户取消/真实失败 stub 通过 |
| Server Codex buffered | adapter/runner、RuntimeService | 首响应未知、结束/停止一致性 | timeout=0 代码/build 通过；完整矩阵待验 |
| Generic LLM 普通 | fetch 内层 AbortController、RuntimeService | headers/body 静默、真实连接失败 | 非流式跨观察仍成功/耗尽不重试/格式与错误回归通过 |
| Generic LLM tool-loop | 每轮 fetch、工具生命周期、RuntimeService | 原调用继续、工具阈值/硬限制分离 | 长 fetch 不 abort、显式 stop 及工具回归通过 |
| 系统 RuntimeInvocation / Worker | 调用入口、队列/lease/恢复、RuntimeService | 不被外层 phase timer 误杀、不重放 | 共用监督/既有回归通过；重启交叉矩阵待验 |
| StructuredOutput 纠正 | guard、原操作额度、adapter | 已知输出异常与纠正等待分开 | guard 到时不失败、一次纠正/重复去重/真实耗尽回归通过 |

- [x] RuntimeService 全部 10 个 AgentRunPhase 都有健康与静默跨阈值不取消的 stub 用例。各 provider × phase × 故障交叉覆盖仍待 T12，不据此宣称全矩阵完成。
- [ ] T01 计时器清单中的每个 owner 都有取消来源断言；未清点的内层 AbortController 不得留作“后续处理”。
- [ ] 队列/启动预检/未预留额度仍有准入界限，模型 unknown_wait 语义不扩散到未启动任务。
- [ ] 用户停止、权限撤回、批准硬政策和可信结束安全回归全部保留。

## 5. 验证命令与执行约束

以下是仓库已有入口，本轮实际结果见第 7 节。根类型检查与构建已执行但未全通过；不是仅文档验证。

```powershell
npm run typecheck
npm run test -w @agent-cluster/shared
npm run test -w @agent-cluster/local-runtime-cli
npm run test -w @agent-cluster/server
npm run test -w @project/web
npm run test:desktop
npm run build
npm run test:harness
```

相关 E2E 入口：`npm run test:e2e:cancel`、`npm run test:e2e:recovery`、`npm run test:e2e:claude-streaming`、`npm run test:e2e:codex-streaming`、`npm run test:e2e:runtime-provider-fallback`、`npm run test:e2e:generic-llm-response-shapes`、`npm run test:e2e:browser-local-runtime-cli`、`npm run test:e2e:client-presentation`。执行前确认脚本确实使用隔离 stub/状态，不自动启动真实付费 CLI 或触碰现有活动任务。

实际已加入的专项证据入口：

- shared `runtime-request-health.spec.ts`：合同、能力、脱敏事件结构。
- server `common/runtime-health-policy.spec.ts`：纯策略、假时钟、去重、停止优先。
- CLI `runtime-process-stop.spec.ts`、runtime/adapter/protocol-handler/transport 回归与扩展：进程/观察/probe 生命周期；没有虚构新增 runtime-process.spec.ts。
- server RuntimeService、Local Runtime、Generic LLM、存储和 sessions API 定向扩展：计时器、预算、竞争与恢复。
- Web/desktop 组件及 store 定向扩展：快照/SSE、等待/停止、多调用。
- `apps/web/tests/fixtures/runtime-request-health.html/.ts`：实际共享面板/store，Web 与 Desktop 样式，fetch 全部 stub。它不是全矩阵 smoke；`tests/e2e/runtime-request-health-smoke.mjs` 尚未创建。

PostgreSQL/迁移/更新验证使用独立测试实例和备份；真实模型/生产更新需要批准记录。旧测试中的“静默必取消”断言应按 Spec 更新，但不能删除停止安全测试来求绿。

## 6. SDD 与交付审查

- [x] 四份文档保持 RH-FR/Task/RH-AC 追踪，实际字段以 shared 源码为准；Plan 第 14 节登记目标与实现差异。
- [ ] 所有模式和 provider 路径通过，剩余参数及能力限制有记录，未知不等于确定健康或确定失败。
- [ ] 保留原调用、可信停止、预算账本、隐私和资源边界无缺口；不新增未知 TTL、不依赖 thinking 开关。
- [ ] 代码、合同及运行说明同步；不存在旧 timer 在另一路径先取消的漏项。
- [x] 未回退并行专项；无提交、发布、部署、原服务重启、真实模型请求或 DingTalk 操作。
- [x] 实现证据、隔离组件验收和生产加载分别报告；未执行/复合项保持未完成。

## 7. 证据登记

以下为本轮真实记录，Windows 本地隔离临时目录/stub；时间均为 2026-09-29 UTC。原监听服务、生产数据库及真实模型未参与。终端回执是测试计数的来源，仓库内保存的是可复跑用例与截图，未伪造额外完整日志文件。

| Task / RH-AC | 用例与命令 | 环境 / 时间 | 退出码 / 结果 | 脱敏报告路径 | 未完成原因 |
| --- | --- | --- | --- | --- | --- |
| V1：T01–04、T11 / AC01–03、11 | `npm run test -w @agent-cluster/shared` | stub/本地临时目录，03:32 起 | 0；255 通过 | `packages/shared/src/runtime-request-health.spec.ts`、`runtime-activity.spec.ts` | 全供应商隐私矩阵未验 |
| V2：T03–06、T12 / AC03、09、12、13 | `npm run test -w @agent-cluster/local-runtime-cli` | stub/本地临时目录，03:20–03:22 | 0；95 通过 | CLI runtime/transport/protocol/stop specs | 真实旧 CLI partial/跨版安装未验 |
| V3：T02、T05–09、T12 / AC01–09、12–14 | `npm run test -w @agent-cluster/server` | 纯策略、stub、file 临时状态，03:25–03:30 | 0；1840 通过、20 跳过；开发脚本另 7 通过 | health-policy、health-store、health-probe、RuntimeService、Generic、两个 streaming runner、structured-output-guard、relational 与 sessions specs | 未配置独立 PostgreSQL，20 项不是通过 |
| V4：T02、T08、T09 / AC04、06、09、12 | server cwd：`node ../../node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.json --test --test-force-exit src/common/runtime-health-policy.spec.ts src/modules/runtimes/runtime-health-store.spec.ts src/modules/runtimes/runtime.service.spec.ts src/modules/sessions/runtime-health-api.spec.ts` | 03:22–03:24 | 0；78 通过 | 上述源测试；含 10 phase、删除 fence、file reload | 不替代真实跨进程重启/PG |
| V5：T10、T13 / AC06、09、10 | `npm run test -w @project/web`；最新面板/Workspace 定向复跑 | jsdom，03:20–03:21；03:34 | 0；370 通过；定向 16 通过 | `RuntimeRequestHealthPanel.spec.ts`、`SessionWorkspace.spec.ts`、共享 store | 全量后补旧 epoch 高版本防护，定向已覆盖 |
| V6：T10、T13 / AC05、06、10 | Playwright `request-health`，独立 Vite 18189 fixture，Web/Desktop CSS | 390×844、1440×900，03:08–03:35 | 等待只有原 wait POST，ID/deadline 不变；Session 全停仅一个 STOP；查询失败保留状态；终态收起调用提示 | `output/playwright/runtime-health-web-mobile.png`、`runtime-health-desktop-mobile.png`、`runtime-health-desktop.png`；`apps/web/tests/fixtures/runtime-request-health.*` | fixture 不启动后端/模型，不是打包 Electron E2E；截图目录被忽略 |
| V7：T12、T13 / AC15 | `npm run test:desktop`、`npm run test:harness` | 本地回归；Harness 于合同/四文档同步后 03:38 再跑 | 0；Desktop 14 通过，Harness 全阶段通过 | Desktop specs、现有 Harness 脚本 | 仅单元/工程护栏，不证明 renderer 打包通过 |
| V8：T13、T14 / AC15 | `npm run typecheck`、`npm run build` | 当前 dirty 工作树，03:30–03:32 | 1；CLI/shared/server 类型与构建、Desktop main 类型通过；Web 与 Desktop renderer 被 restore 残留绑定阻挡 | Web Sidebar:102 / Workspace:1863；Desktop Sidebar:109 / Workspace:1898 | 并行 archive/delete 改动，未擅自回退或修复；整仓门禁未通过 |
| V9：T13、T14 / AC15 | 经用户批准清理侧栏后：`npm run typecheck`、`npm run build`；Web 完整及定向测试；`npm run test:desktop` | 当前 dirty 工作树；03:58 登记，Web 全量复跑 03:56 | 0；整仓类型检查/构建通过；Web 372 通过，定向 35 通过；Desktop 14 通过 | 两端 Sidebar/Workspace、Sidebar specs、session-delete-lifecycle spec | 构建仍有非阻断 chunk/PURE 警告；不证明运行服务已加载或完整专项验收 |
| V10：构建阻挡修复的补充验收 / AC15 | `npm run test:e2e:session-archive-desktop`；`npm run test:harness` | Electron + 随机端口 26389/file/临时 profile，Mock 强制；04:03–04:04；Harness 04:01 | 0；真实 Electron 归档/恢复 UI + 接口事实通过；Harness 全阶段通过 | `tests/e2e/session-archive-desktop-smoke.mjs`；`output/playwright/session-archive-desktop/{archived,restored}.png` | 仅侧栏归档流程，不是请求健康专项全贯通、桌面安装包更新/回退或真实 PG 验收 |

命令纠错：一次从根目录直接 `node --import tsx` 的定向运行缺少 server decorators tsconfig；一次将文件参数追加到 npm server test，主单测通过后脚本第二段找不到路径。这两次退出 1 是调用方式错误，未计为通过；V4 以正确 cwd/tsconfig 复跑，V3 以无追加参数的完整脚本复跑通过。

V9 复测记录：新增断言首次沿用了旧 `.session-archive-item` 选择器，定向测试 29 通过、2 失败；改为真实归档卡片结构后通过。第一次 Web 全量为 371 通过、1 失败（`ChatTimelineDiscussionDocument` 的迟到响应断言），未修改该无关文件；其定向复跑及再次全量均通过，保留首次失败记录，不将其计为成功。

V10 复测记录：首次桌面 smoke 在归档成功后定位“归档管理”超时，退出 1，未复现其页面状态。第二次旧断言报告通过，但截图复核发现它只等到了原归档卡片，不能证明恢复已完成，故不计为恢复验收。新增失败截图/控制台诊断，并将固定 300ms 等待替换为接口响应；最终第三次同时校验 archive/restore 的响应事实、全部页签、归档列表退出、选中卡片和服务端 `archivedAt` 清除后通过。截图复核通过；独立 Electron/server 已关闭、测试数据文件已删除，原服务和真实会话未动。

剩余项不是仅“待批准上线”：T07 内部 requestAttemptId/结束关联、T11 全局历史/待同步容量与通知冷却/指标/压力测试、T12 provider × phase × 故障矩阵还需开发与验收。真实 PG、CLI 跨版、打包 Electron 和更新/回退需隔离环境及相应授权。当前不标 T01–T14 或 RH-AC01–15 全部完成。

收尾检查（2026-09-29 03:40 UTC）：四文档 14 个本地链接/锚点、12 个 FR、15 个 AC、14 个 Task、32 个场景及代码块/尾随空白检查通过；`git diff --check` 无空白错误。UI 最后将按钮/焦点蓝色加深到 `#2161b0`，对白色对比度约 6.17:1，面板 3 项测试复跑通过。截图为此前相同布局的浅蓝文字版本。独立 fixture 浏览器及 18189 Vite 已关闭，未停止原服务。

文档生成检查记录（2026-09-29 02:10 UTC）：以只读 Node 校验四文件，14 个相对链接及锚点、12 个需求定义、15 个验收定义、14 项任务与无环依赖、32 个场景编号、13 个现有脚本入口均通过；同时检查标题/列表空行、代码块闭合、尾随空白及不存在已完成的功能复选项。

该历史记录只证明初始文档结构。此次开发证据另见 V1–V10；未执行生产迁移、真实模型请求或原服务重启，也未确认原运行实例加载新策略。

## 8. UI 可读性补充验收（2026-09-29）

按用户截图反馈，仅补充共享 Web/Desktop 面板的用户文案与消息弹窗，不修改 Runtime 计时器、预算、模型请求或停止流程。界面合同见 [UI State Contract 第 14 节](../contracts/ui-state-contract-v0.1.md#14-执行停止摘要)。默认摘要展示 Agent 名称、中文阶段和 Runtime 名称，内部编号/规则版本折叠解释；所有能力与进程/请求状态提供中文说明。

- Web 全量：`npm run test -w @project/web`，74 文件、382 项通过；最终文案与局部中文配置复跑仍通过。
- 定向：`RuntimeRequestHealthPanel.spec.ts`、`runtimeHealthPresentation.spec.ts`、`SessionWorkspace.spec.ts`，26 项通过。覆盖字段解释、立即可用的空记录入口、每页 20 条、会话隔离、事件去重、未知能力不误判、凭据/路径隐藏与原等待/停止行为。
- Web 类型检查与 `npm run build -w @project/web` 通过；构建保留既有 PURE 注释和大 chunk 警告。
- Desktop renderer：Web cwd 下 `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p ../desktop/renderer/tsconfig.json` 通过。一次根目录 `npx vue-tsc` 未找到 workspace 命令，改用实际本地入口后通过，不把该次失败计为成功。
- `npm run test:harness` 通过；UI 合同空白检查通过。
- Playwright 隔离 fixture：Web 1440×900、390×844 和 Desktop CSS 390×844 验证弹窗、逐条消息及中文说明。390px documentWidth=390；查看期间模型 mutation 数为 0。Esc 关闭后焦点回到“Runtime 消息”。两次浏览器会话重置造成引用失效，换独立命名会话重新验证；无效空白截图不计为证据。
- 真实现有群聊只读核验：摘要不再显示 Agent UUID，弹窗从已加载的历史事实生成分页记录，未点击等待、停止或重试。截图：`output/playwright/runtime-messages-live.png`；隔离截图：`runtime-messages-web-desktop.png`、`runtime-messages-web-mobile.png`、`runtime-messages-desktop-style-mobile.png`（均在 `output/playwright/`，被 Git 忽略）。

以上只证明本次 UI 补充，不代表请求健康专项剩余 T07/T11/T12 已完成，也不替代打包 Electron E2E。未重启服务、未发起真实模型调用、未执行数据库操作、提交、发布或 DingTalk 操作。

## 9. 仅展示当前调用（2026-09-29）

按用户要求，默认状态区及弹窗“当前调用状态”排除历史与终态快照，计数使用同一集合。没有当前调用时不回退展示历史；当前未知或停止中调用仍保留。历史持久化数据、消息记录和等待/停止流程不变。补充同 generation/version 历史标记保护，防止重放的旧 SSE 将历史记录恢复成当前调用。

- 回归用例修复前：面板 10 项中 4 项失败，复现历史误计数、终态回退及同版本重放问题；修复后 10 项通过。
- 定向：`npm run test -w @project/web -- RuntimeRequestHealthPanel.spec.ts runtimeHealthPresentation.spec.ts SessionWorkspace.spec.ts`，3 文件、29 项通过。覆盖多当前调用、历史保留、等待/停止、终态收起、无当前调用和重放保护。
- Web 类型检查、Web 构建、Desktop renderer 类型检查均通过；构建仍有既有 PURE/chunk 警告。`npm run test:harness` 通过。未重新运行整仓测试。
- Playwright 只读核验现有群聊：API 返回 2 个终态、1 个历史及 1 个当前调用；默认区显示“当前 1 个调用”，弹窗仅一个当前状态详情，消息记录仍可查看。未点击等待、停止或重试。截图：`output/playwright/current-runtime-only.png`（Git 忽略）。

本次不修改服务端超时/预算策略，不重启服务，不删除历史数据，不发起真实模型请求，不执行提交、发布、部署或 DingTalk 操作。专项未完成项仍以第 7 节为准。

## 10. 明确异常未恢复的预算兜底验收（2026-09-29）

用户已批准按日志排查后的方案实现。本次修复的对象是“已收到明确流中断/限流/重试，却因静默 tick 覆盖健康状态、预算另有错误分类而未兜底”，不是用进程在线证明模型正在思考。对应 Spec 第 9 节、Plan 第 15 节及 Tasks RH-P01–08；之前的记录保留。

### 10.1 范围及根因

- 会话 `573193b7-433f-43fb-897a-39d841808774` 的调用开始于 2026年09月29日 14:49:00，原截止 15:09:00。14:59:11 记录流提前中断，15:11–15:30 记录 429/502 与 CLI 内部重试；控制连接仍在线。15:31 后恢复工具动作，15:45:36 完成。上述时间为 Asia/Shanghai，不能把这段约 57 分钟等待直接归因为 Runtime 进程挂掉。
- 原健康 reducer 在静默观察时将已知 provider retry 降为 unknown；原预算分类又遗漏 `api_retry` 和请求观察 provider 错误。两个问题共同导致异常后未正确执行原预算兜底。
- 现有 Runtime 长生命周期进程未协商 `requestHealthProtocol:1`，仅代码/构建变化不证明该进程具备探测能力。本次按当前连接协商初始化能力，但不自动更新或停止该进程。

### 10.2 实现及断言

- [x] 三种真实错误编码共用 shared 分类、健康 reducer 和同一 live budget 状态；异常在 tick/heartbeat/start/ack/存活或无效 probe 后仍保持。
- [x] 有真实恢复进展后解除 provider 故障；之后再静默属于未知，不继续沿用旧故障。相同工具的不同进展保留，回放/重复/异会话事件不刷新进展。
- [x] 纯静默/无思考/不支持探测继续保留同一 invocation，原截止/attempt 不续期。工具错误与格式纠正分开，成功 StructuredOutput 提交解除格式提示。
- [x] 明确进程退出或控制断线不能被迟到活动/无关错误改成健康；退出 probe 不等于业务终态。
- [x] 超原截止的明确异常只启动一次调用、取消一次；迟到成功不发布完成，可信停止屏障仍生效。健康辅助保存失败不会触发模型重跑。
- [x] Web/Desktop 共用安全中文解释：限流、流中断、工具错误、格式纠正、异常时间及预算停止。历史/终态默认过滤与消息记录不变，终态不声称仍在恢复。
- [x] 可选诊断字段白名单、旧快照兼容和私密正文/凭据排除经过测试；协商能力测试没有发起 probe 或额外模型请求。
- [ ] 真实运行进程安全更新、重新协商及加载版本核验：等待另行批准，不能因构建成功打勾。生产迁移、真实模型及完整专项剩余矩阵仍未执行。

### 10.3 验证记录（08:22 UTC 起，本地 stub/临时状态）

| 验证 | 命令/范围 | 实际结果 |
| --- | --- | --- |
| 缺陷红灯 | budget-policy、health-policy 两文件，新失败断言 | 修复前 13 项中 2 项失败；相关核心修复后 22 项通过 |
| 后端专项 | server cwd 的 tsx `--tsconfig tsconfig.json --test --test-force-exit`；execution-budget-policy、runtime-health-policy、runtime-health-store、runtime.service、runtime-health-probe | 初次 94 项通过；补充进程退出/异常优先级后最终 95 项通过 |
| 共享全量 | `npm run test -w @agent-cluster/shared` | 初次 263 项中 1 项新增 fixture 失败：成功工具回执误设 debug；按实际 user 回执修正并保留 debug 不计进展断言后 264 项通过 |
| Web 全量/专项 | `npm run test -w @project/web`；面板、presentation、Workspace 定向 | 全量 77 文件、408 项通过；最终定向 3 文件、31 项通过 |
| CLI/Desktop | `npm run test -w @agent-cluster/local-runtime-cli`；`npm run test:desktop` 的等价 workspace test | CLI 96 项、Desktop 14 项通过；不等价于真实 CLI/打包 Electron 全贯通 |
| 后端全量 | `npm run test -w @agent-cluster/server` | 1874 项：1853 通过、1 失败、20 跳过；脚本因失败未执行后续开发脚本段，不能称全量门禁通过 |
| 类型/构建/Harness | `npm run typecheck`；`npm run build`；`npm run test:harness` | 整仓类型与构建通过；Harness 全阶段通过。最终补充文案后再构建并检查 Desktop renderer 类型；见下方收尾记录 |

后端全量唯一失败为 `generic-llm-tool-loop-budget.spec.ts` 的“首轮在 1000 Token 内发送、第二轮才拦截”假设，实际发送数为 0。独立复跑仍 2 通过、1 失败：当前初轮容量 guard 已拦截，并非本补丁 healthy/unknown 监督取消。该测试直接运行 Generic service，不经过本次预算/健康监督；本轮未修改 Generic 的 Token 准入、估算器或该测试。保留失败记录，不扩大范围去削弱容量限制或调整无关 fixture。

UI 改动仅文案/状态解释，使用源码与组件测试验证，没有新增布局或重复浏览器流程；本次未执行真实双端 E2E。全量 Web 有其他模块 `<details>` 嵌在 `<p>` 的警告，构建仍有既有 PURE/chunk 警告，均未改动相关无关模块。

本轮采用先失败回归再修复、同一状态决策、合同和四文档同步的工程流程。没有重启原服务、停止真实调用、写生产数据库、发起真实模型请求、DingTalk 操作、提交、发布或部署；活动任务未热切策略。代码候选通过上述相关验证，不代表运行实例已经生效，也不关闭第 7 节剩余专项门禁。

收尾复验（2026-09-29 08:37 UTC 登记）：最终共享包全量仍为 264 项通过；最终整仓构建与 Desktop renderer 的独立 `vue-tsc --noEmit -p apps/desktop/renderer/tsconfig.json` 通过。全工作树 `git diff --check` 无空白错误，另对本轮新增/既有未跟踪文件检查尾随空白与冲突标记；保留全部其他 dirty 改动。服务端全量的唯一 Token fixture 失败未处理，不宣称整仓测试全绿。未重新执行真实浏览器/进程升级验收。
