# Runtime 请求健康与未知等待 Plan v1

状态：2026-09-29 核心方案已实施为代码候选。下文保留设计目标，实际字段、已验证落点和未完成项见第 14 节与 Checklist；未上线。

依据：[Spec](../product/runtime-request-health-spec-v1.md) | [Tasks](../implementation/runtime-request-health-tasks-v1.md) | [Checklist](../quality/runtime-request-health-checklist-v1.md)。

## 1. 目标、决策与选型

目标：所有已启动模型路径统一采用“证据分层 → 健康决策 → 观察/异常处置”，与思考模式独立。用户已选择 unknown_wait 保留原调用，不自动取消；代码实现前无需重新询问该决策。

| 方案 | 优点 | 缺陷/取舍 |
| --- | --- | --- |
| 延长或全局关闭旧 timeout | 改动小 | 没有可解释状态，可能保留明确故障；多层 timer 仍不一致 |
| 只以 thinking/reasoning 续期 | 可利用现有流事件 | 关闭思考、隐藏内容和 buffered 请求不适用 |
| 请求级证据 + 统一健康状态机 + 未知保留 | 模式独立，用户可控，可追踪异常 | 需改合同、各 adapter、watchdog 与双端；不可观测卡死仍可能被保留 |

选择第三种。第一期不引入透明代理、不重写 Runtime、不强制本地 Codex 迁移 app-server。网关请求状态是将来的可选增强，不是上线前提。

## 2. 当前系统落点与差距

| 模块/当前路径 | 当前行为 | 目标职责 |
| --- | --- | --- |
| `packages/shared/src/runtime-activity.ts`、`runtime-streaming/` | 有效输出与 debug/transport 分类，未建请求级未知语义 | 统一活动类别、去重、能力与健康合同 |
| `packages/local-runtime-cli/src/adapters/claude-code-adapter.ts` | stream-json 逐行上报，缺 partial/thinking 解析 | 采集可选增量、retry 及终态，不改变思考设置 |
| `packages/local-runtime-cli/src/adapters/codex-adapter.ts` | exec JSONL 捕获最终输出，未回传逐行进度 | 增加 JSONL 观察，按实际能力降级 |
| `packages/local-runtime-cli/src/runtime-process.ts`、`runtime.ts` | 管理进程/取消，未提供 invocation 级探测合同 | 精确进程实例状态、只读探测与终态证据 |
| server `modules/runtimes/streaming/` | first-frame/idle/absolute watchdog，未知通知落 debug | 识别 reasoning/工具进展，阈值转成观察事件 |
| server `modules/local-runtime/local-runtime-connection.service.ts` | 有设备心跳/独立 idle timer，断线中断句柄 | 连接与执行分层，探测和停止确认不混淆 |
| server `common/execution-budget-policy.ts`、`modules/runtimes/runtime.service.ts` | 截止后无进展/连接不健康可直接取消 | 唯一的调用级决策，未知不取消 |
| server `modules/runtimes/generic-llm-runtime.service.ts` | 普通与 tool-loop fetch 自有 absolute abort | 记录每个内部请求，模型静默进入未知，不抢先 abort |
| server `modules/orchestrator/orchestrator.service.ts`、`structured-output-guard.ts` | 有界纠正、UI 心跳、重试和业务状态 | 消费执行结果；心跳不成为模型进展；纠正观测纳入共同策略 |
| server `modules/runtime-invocation/`、`modules/recovery/` | 系统调用与重启恢复 | 系统 Agent 同策略，恢复不重放模型 |
| shared 合同、persistence/events、Web/desktop | 已有停止屏障、SSE/outbox、双端状态 | 新增正交健康投影，不改变领域输出合同 |

实际文件名以 T01 清点和实施记录为准；当前工作树含其他专项改动，不整体替换模块或回退未知差异。

## 3. 架构边界与不变量

允许后续修改：上述 Runtime/Local Runtime、共享合同、必要的 sessions/debug/persistence/events/recovery 调用点、共享 API/store 与双端状态组件、定向测试和合同文档。

禁止顺带修改：模型/思考配置、Provider 凭据、目录授权、业务阶段规则、工作区写回、顶部导航、未知任务自动恢复、Harness 产品化、无关 UI 风格。

- I1：健康观察状态不是 invocation 业务结果，也不是可信停止事实。
- I2：unknown_wait 不 abort、不 settle、不调用 pause/resume、不增加平台尝试。
- I3：用户停止及生命周期 generation 先于健康事件；终态不会被迟到活动复活。
- I4：心跳/CPU/进程/PID/active 状态只证明对应层，不能单独证明模型计算。
- I5：探测零模型请求；当前调用身份不可变；状态事件和最终业务输出分离。
- I6：时间阈值不隐式变成硬政策上限；批准硬限制、权限和可信停止不被削弱。

推荐数据流：

```text
CLI/HTTP 原生信号 → Runtime observation 归一化 → 调用健康 reducer
                                                ↓
                             RuntimeService 策略决策与健康快照
                                   ↓                     ↓
                           观察/只读探测          明确异常/用户停止
                                   ↓                     ↓
                              unknown_wait        既有可信结束屏障
                                   ↓
                            API + 状态事件 → Web/Desktop
```

## 4. 共享合同设计

shared 已增加独立 `runtime-request-health.ts` 及合同测试，避免把 provider 原始数据散布到 UI。以下描述目标合同；实际字段以该源文件为准，不能将目标中的可选 request/终态关联解释为所有 adapter 都已提供：

- `RuntimeObservation`：sessionId、operationId、invocationId、sessionGeneration、observerEpoch、sequence、observedAt、source、kind；可选 requestAttemptId/providerRequestId、toolCallId、计数和脱敏错误分类。
- `kind`：request_started、request_acknowledged、reasoning_progress、text_progress、tool_input_progress、tool_started、tool_progress、tool_completed、transport_alive、provider_retry、provider_error、control_disconnected、process_exited、terminal_received、probe_result。
- `RuntimeHealthSnapshot`：schemaVersion、调用身份、单调 version、stage、health、reasonCode、能力、最后各层观察时间、原 deadline、是否超过观察阈值、unknownSince、lastWaitAcknowledgedAt、可用操作及终态引用。
- `stage`：starting / awaiting_response / reasoning / responding / tool_running / retrying / unknown_wait / stopping / terminal。
- `health`：progressing / unknown / abnormal / terminal。进程状态使用 alive / exited / unknown；请求状态使用 pending / receiving / ended / unknown；禁止用一个 connected 布尔值代替全部层级。
- 能力：progressEvents、reasoningEvents、processProbe、requestLifecycle、providerRequestQuery。每项 supported/unsupported/unknown；能力缺失不宣称请求失败。

providerRequestId 只有上游提供时才填写；requestAttemptId 是平台观察到的内部请求序号，不能冒充供应商真实请求 ID 或不可见的 HTTP 次数。CLI 不暴露 request_started 时，不能由 tool_completed 自动推断下一次模型请求已发送。

单调时间用于当前进程的间隔判断；UTC 时间用于审计。原生事件时钟不可信，时间间隔以接收方观测为准。observerEpoch 与进程实例启动标识避免重连序号归零和 PID 复用误绑定。

## 5. Reducer 与证据规则

已新增 server `common/runtime-health-policy.ts`，提供纯 reducer；适用的归一化工具留在 shared。Reducer 输入只包括已验证的 observation、能力、明确策略与单调时钟，不直接发网络/写库/启动进程。

| 输入/情形 | 状态转移 | 动作 |
| --- | --- | --- |
| 有序的新正文/参数/reasoning 活动 | progressing，按来源设置 stage | 保留当前调用；清除已恢复的临时异常 |
| 单独 start/ack、native active、SSE ping、进程 alive | awaiting_response 或维持原状态 | 更新对应层时间，不续模型进展 |
| 观察阈值到达且无进展/无法判定 | unknown_wait / unknown | 发一次状态变化，调度有界只读 probe，不取消 |
| probe 超时、unsupported、旧健康信息过期 | unknown_wait / unknown | 标明信息不足，不伪造 provider timeout |
| 请求明确失败、api_retry、链路明确中断 | retrying / abnormal 或故障收尾 | 既有恢复额度决策；区分进程结束未知 |
| 用户停止/生命周期替换 | stopping | 停止优先，冻结业务输出应用 |
| 匹配终态/可信 result | terminal | 一次性收尾；后续 pulse 不复活 |

reasoning start 是阶段提示，不是永久健康豁免。完整 thinking 消息只证明发生过活动；partial 和最终 assistant 重复内容去重。空 delta、signature、固定 heartbeat 和重复 usage 不构成不断产生新进展。用 native event/item/block 索引、单调序号及 bounded 去重窗口，不仅凭文本相等去重，避免把两次合法相同 token 当回放。

思考关闭时，不期待 reasoning，不更改模型设置。隐藏思考且无可用 delta、非流式无正文时进入未知。界面只在证据新鲜时显示“正在思考”，其他时间显示“等待模型响应”，不以旧 thinking 状态无限续期。

多 Agent 以 invocation 为单位跟踪，不以设备健康给全部 Agent 续期。Session 健康摘要派生出正常/未知/异常数量，保留每个调用明细，不另建可漂移计数器。

## 6. 各路径采集与探测

### 6.1 Claude 本地与服务端

默认受支持参数增加 include-partial-messages，shared parser 处理 stream_event 的 message/content block 生命周期、正文/参数/thinking 活动，以及 system/api_retry 等脱敏诊断。最终 structured_output/result 验证不依赖增量拼接；部分 JSON 不得作为最终合法输出。

只从 thinking 事件提取存在性、事件键和大小，不将原始内容/签名放入 RuntimeStreamFrame.raw、stdout 长期缓存、事件库或审计；保留 provider 必要的内部解析生命周期，但界面不显示思考正文。自定义参数与不支持 partial 的 CLI 进入能力降级，不能默默修改用户配置或自动重跑以试参数。

### 6.2 Codex 本地与服务端

本地 exec 增加逐行 JSONL 观察，识别实际版本支持的 item/turn 事件；未暴露的 reasoning/request 生命周期声明 unsupported。服务端 app-server parser 识别 reasoning summary/text delta 及工具输出，原始推理只提取活动元信息。thread/read 可做无副作用查询，但 active/inProgress 不是计算进展证明。

本专项不强制迁移本地 exec 到 app-server，不虚构 exec 的状态查询端点。CLI 官方能力与当前版本通过 stub/本地 help 或协议 fixtures 校验；真实付费请求须额外批准。

### 6.3 Generic LLM 和 legacy/buffered

在现有 fetch 生命周期观察每次普通/tool-loop 请求，保留 AbortSignal 用户理由。可观察的 headers/body/正文增量按实际协议记录；不支持 streaming 的连接允许只记录 started/ended 并未知等待，不为了诊断更换协议或模型。

模型等待的自发 absolute abort 改为 observation 回调；真正 TCP/TLS/HTTP 失败保持异常分类。供应商/CLI 自身超时是已终止请求事实，不能由平台抹掉；本地设置的静默定时器不允许换个名称绕过 RH-FR04。

### 6.4 invocation 只读探测

拟扩展 Local Runtime 协商能力与消息：`local_runtime.invocation.probe` / `local_runtime.invocation.probe.result`，精确绑定 device/workspace/invocation/generation/进程实例。返回是否登记、进程实例、可观察请求状态和最后活动；无上游能力时明确 unknown。

探测限流，单调用最多一个 in-flight probe；超时清理 pending，不 abort 被观察任务。用应用级 challenge/response 判断控制通道是否可响应；Runtime 自发定时 ping、系统 CPU 或另发一次测试模型请求都不能替代 probe。未匹配/过时响应不改变状态。

## 7. 统一 watchdog、预算与恢复

RuntimeService 是调用级政策决策者；adapter/Worker/Local Runtime 报告观察和真实失败，执行显式取消与批准安全硬限制。所有 first-frame/idle/absolute 到时首先归一化为 observation_due；禁止 runner 或 Local Runtime 提前 terminateChild。

实施时逐一核对 RuntimeService、Local Runtime idle、服务端 streaming 与 buffered runner、Generic LLM 两类 fetch、Worker 生命周期、系统 RuntimeInvocation、StructuredOutput guard。不同层不能独立对未知累计时长作失败结论。

- 既有 phase timeout、idle 阈值用作观察频率依据，deadline 仍记录原操作时间，不给自动重试新额度。
- 健康/未知的同一 invocation 可继续正常内部工具轮转及模型请求；不因此获得新的平台 attempt。
- 新 invocation 的 reserve、已用次数、输入/输出 Token 校验保持原语义；正常当前调用结束后，下一业务阶段依既有逻辑建立操作。
- 真实错误时按剩余原预算、尝试上限、allowlist/circuit 决定有限恢复；预算已耗尽不能另启 provider 调用。不可见 CLI 内部重试记录为未知，不能假称被平台精确控制。
- 普通工具时限是观察阈值：长工具有进展继续，无法核实进入未知；明确批准的工具硬安全上限仍可取消并标 policy_limit。
- StructuredOutput 非法提交是已知合同异常；一次纠正额度保留。纠正模型正在等待时，其 300 秒等观察阈值不是无条件 abort；纠正次数耗尽或实际修复失败仍按合同失败处理。
- 真正用户取消、授权撤回、终态、会话 generation 替换及批准资源硬限制保留优先级。

断线触发现有可信停止保护：健康标 abnormal，若请求/进程结束不能核实则保留 stop-unconfirmed。没有连接不等于 CLI 已退出；在旧进程未知期间不得重试替代执行。

## 8. API、状态事件与持久化

已增加健康快照集合 `runtimeHealthBySession`，按 Session 分组、invocation 唯一，包含 schemaVersion、sessionGeneration、observerEpoch、version、stage/health、原因、能力与时间，不包含推理/提示正文。可信业务结果仍由既有操作/停止账本权威管理。状态变化持久化，频繁 pulse 在内存合并，不逐 token 写数据库。

已接入接口（现有单用户部署边界，不新增多租户鉴权）：

| 接口 | 行为 | 边界 |
| --- | --- | --- |
| GET `/api/sessions/:sessionId/runtime-health` | 返回调用健康快照、版本和可用操作 | 只读，不启动探测模型或调用 |
| POST `/api/sessions/:sessionId/runtime-health/:invocationId/wait` | 提交 expectedVersion/sessionGeneration/idempotencyKey，确认继续等待并去重提示 | 不调用既有 resume、不重启、不增加额度；过时/终态返回冲突及当前快照 |
| 既有停止入口 | 精确目标取消；若仅有 Session 级能力，UI 清楚写“停止会话全部调用” | 不伪称单调用停止，不绕过停止屏障 |

复用已有事件/outbox 机制，使用 `runtime_progress` + payload code `RUNTIME_REQUEST_HEALTH_CHANGED` 和类型化健康摘要。仅状态转换或用户确认产生可见事件，事件身份 `runtime-health:<invocationId>:<version>`；状态和事件原子提交，按既有集合锁排序，锁内不进行探测或模型调用。健康事件不进入聊天时间线。

file 与 PostgreSQL 都须接入集合读取、schema 校验、关系表映射、迁移、备份、cutover、replace-state 及 outbox 读取；迁移编号实施时选下一个未占用号，不冲突复用其他专项的版本。

数据库失败不能触发模型重跑或故意 cancel 健康调用；内存保留受限当前投影、显示待同步，按既有有限重试恢复。业务结果应用仍遵循可信结束与保存成功门禁；不因健康写失败放开准入。

重启后所有快照仅为历史信息，live health 降为未知。先核对既有预留、进程/回执和 owner/generation，不假定旧 PID 存活；无法可靠重新接管的 server Worker 遵循原中断/未知停止恢复流程，而不是创建替代任务。可靠关联的 Local Runtime 可继续上报原调用观察/结果，实际安全恢复由停止合同约束。

## 9. 双端交互

复用 shared 健康模型与 Web store/API，Web 和 desktop 各自布局。状态显示位于现有 Runtime 执行区域/消息卡片，不增加顶部导航或额外顶部字段。

- progressing：按证据显示正在输出/工具执行/正在思考。
- unknown_wait：“等待模型响应／状态未知；暂未收到新的执行进展，当前调用仍保留。”显示最后进展时间、已等待时长、可观测能力与等待/停止操作。
- retrying：显示脱敏错误类别及实际可见重试进度，不显示为思考。
- stopping：显示可信停止进度；不能立即变为已停止。
- terminal：既有成功/失败/取消结论为准，未知提示自动收起。

健康状态与业务 SessionStatus 正交；未知不进入需要结束活动调用的 WAIT_USER_CONFIRM 流程。浏览器断线/刷新仅影响观测，不触发取消。先获取权威快照再合并 SSE；version/generation/epoch 校验防止旧事件倒退。健康查询失败显示观测不可用，保留已知可信终态。

## 10. 配置、性能和诊断

拟定观察配置：silenceObservationMs、progressFreshnessMs、probeIntervalMs、probeResponseTimeoutMs、notificationCooldownMs。沿用现有有效阈值作为第一批观察初值；探测间隔/TTL 在故障测试后校准，非法配置使用有限默认值。任何这些参数到期都不能自动取消 unknown_wait。

不要继续隐式使用 30 分钟等模型绝对 timer 当批准硬限制。独立政策硬限制需要名称、来源和部署批准记录；本专项不新增默认强制总时长。

限制单调用探测数、全局 probe 并发、去重缓存大小、保留事件大小、状态写入频率。结束/取消后清理全部 timers/listeners/pending；未知调用仍占据原并发槽和 worktree，禁止自动释放以制造额外并发。

拟定指标：unknown 当前数/等待时长、observation_due、probe 超时、明确 provider 错误、用户等待/停止、健康取消违规计数。低基数标签只含 runtime/phase/reason；调用 ID 放日志，不作指标标签。日志关联全部身份与策略版本，内容与凭据脱敏。

## 11. SDD 实施顺序与验证

1. T01–T02 冻结证据/合同和纯状态机，先以假时钟写失败断言。
2. T03–T05 补 Claude/Codex 观察与进程探测；不依赖真实模型。
3. T06–T08 统一模型路径监督，处理 Generic LLM 内层等待、异常恢复、停止竞争及预算语义。
4. T09–T11 完成快照/API/事件、双端与诊断；通过相关单元/集成。
5. T12–T14 完成兼容/恢复故障矩阵、双端 E2E、灰度及审查交付。

每项任务的改动落点、依赖和 RH-AC 映射见 Tasks；实际结果填 Checklist。此前 158 项等测试仅是旧工作区回归，不算本专项验收。

## 12. 兼容、上线和回退

先接入合同/能力和观察数据，再在隔离 fixture 中启用新政策，最后按 invocation 启动时冻结的 policyVersion 灰度。新 CLI/server 协商 probe 能力；旧 CLI 即使无 probe，也以现有结果/活动及 unknown_wait 降级，不能谎称具备请求健康查询。

已有活动调用不热切换策略、不自动重跑。服务/Worker/CLI 更新前清点活动任务及停止未确认项；由用户选择保留当前进程等待或显式停止，再执行获批准的更新。确认 source/build/进程启动版本与目标一致，不能只信 runtimeBuildStale=false。

回退先冻结新调用准入，保留运行中新策略调用与健康/停止数据；不得把未知调用重新交给旧的 absolute kill timer。仅在活动调用均安全结束或用户明确停止后切换不兼容版本。迁移采用可回读扩展，不删除事件/健康记录释放屏障。

## 13. 风险、依赖与未决参数

风险：不可观测卡死被长期保留、并发槽/工作区长期占用、CLI 版本差异、错误/结果乱序、状态保存失败、隐蔽内层 timer 与 rollout 误杀。对应验证见 RH-AC03–15。

外部网关不提供请求状态时不阻塞第一期，因为 unknown_wait 已有确定语义。生产探测频率、容量和受批准硬限制需在部署阶段确认；不以缺少采样为由假定模型正常，也不据此实现自动未知 TTL。

外部协议细节以 [Spec 设计依据](../product/runtime-request-health-spec-v1.md#8-设计依据) 的官方文档和实际能力测试为准；不执行真实模型调用、生产迁移或重启作为文档验证。

## 14. 2026-09-29 实施落点与差异

| 层 | 实际实现 | 边界 |
| --- | --- | --- |
| 合同/策略 | shared `runtime-request-health.ts`、`runtime-diagnostic-sanitizer.ts`；server `runtime-health-policy.ts` | count-only、单调时间、4096 去重；unknown 无自动取消 TTL |
| 采集 | Claude shared parser/partial；Codex exec observer/app-server parser；Generic observation channel | 正文/工具/可选 reasoning；未暴露的供应商请求次数仍未知 |
| 监督 | RuntimeService、execution-budget-policy、Local connection、两个 streaming runner、buffered adapter、Generic fetch、StructuredOutput guard | 已启动调用只观察时间阈值；原准入/真实故障/用户停止边界保留 |
| Probe | 协议 11 可选 `requestHealthProtocol:1`；process registry 与 transport/connection | 一调用一个、全局 32；默认响应 5 秒，仅查询登记，不证明模型计算 |
| 存储/API | RuntimeHealthStore、sessions GET/wait、file 集合、PostgreSQL migration v21/关系映射/cutover | 快照+事件+outbox 原子；辅助写失败最多 3 次自动尝试；历史无操作权限；真实 PG 待验 |
| 双端 | Web store + 共用 RuntimeRequestHealthPanel，两端 workspace 挂载 | 停止是会话全停；查询 8 秒/轮询 5 秒；卸载只清理观测 |
| 更新 | 本文第 12 节、local-development 运行说明 | 原服务未重启，活动 invocation 不热切；实际升级/回退未演练 |

配置已落地：`RUNTIME_SILENCE_OBSERVATION_MS` 默认沿用有效 Local idle（600000）；probe interval 默认 30000、response 默认 5000。固定语义去重和合并已实现；独立通知冷却、全局历史/待同步容量压力上限、低基数指标及完整资源压力验收仍未关闭 T11 门禁。Generic 已采集内部请求开始/确认与活动，但每次 requestAttemptId/结束关联、全链账本和跨供应商故障矩阵仍待补齐。

健康快照不是可信终态凭据；停止操作和输出应用仍以既有 operation/stop receipt 为准。真实旧 CLI partial 参数预检、PostgreSQL roundtrip、请求健康专项的打包 Electron E2E、隔离更新/回退没有用 mock 成功代替。2026-09-29 经用户批准清理两端侧栏已删除会话的 `restore` 残留按钮、事件调用与父组件绑定，保留归档恢复/删除及后端墓碑/API；整仓类型检查和构建已通过，证据见 Checklist V9。原运行服务未重启，不能据此声称已加载新策略。

## 15. 明确故障监督与预算决策统一补丁（2026-09-29）

数据流固定为 Runtime 事件 → shared `runtimeEventObservation` → server `reduceRuntimeHealth` → 同一 live snapshot 的预算判断与双端展示。删除预算层独立的异常标志，不让持久化延迟或第二套分类改变监督决策。

1. shared `runtime-observation.ts` 统一原生系统重试、请求观察、普通工具失败及 StructuredOutput 格式错误；回放不计算进展，工具增量不以 toolCallId 单独去重。诊断只保留分类和有限数字字段。
2. `runtime-health-policy.ts` 保持明确故障，tick/弱信号仅更新观察；provider 以真实新模型动作恢复，格式错误以成功提交恢复，控制断线/明确进程退出保留至可信结束。进程探测不是业务终态凭据。
3. `ExecutionBudgetHealth` 只读取同一内存快照。截止前等待；截止后 healthy/unknown 继续观察，未恢复 provider/工具异常或控制断线进入既有停止兜底；terminal/stopping 不重复取消。
4. `RuntimeHealthStore` 增量投影可选 `failure`、`failureAt`、`budgetFallbackReason`，沿用现有集合/事务和 pendingSync。快照 schema/protocol 主版本不变，旧快照仍可读取，历史快照不能参与 live 决策。
5. `RuntimeService` 记录原截止、原因及脱敏故障，先写预算原因再请求停止；沿用 15 秒停止确认与迟到结果屏障。启动能力来自 `supportsInvocationProbe` 对当前连接的协商结果，不发诊断模型请求。
6. 共用 Web/Desktop 面板仅补充中文状态解释和消息内容；不改布局、顶部、等待/停止接口、当前调用过滤或历史存储。

以故障注入 fixture 验证同一个 invocation 只启动一次、只取消一次、迟到成功不发布业务完成，测试不调用真实模型/Runtime。运行实例加载验证与旧 CLI 升级仍需后续批准；本次不重启、取消现有群聊或写生产数据。
