# Runtime 请求健康与未知等待 Tasks v1

状态：2026-09-29 核心代码、定向测试、隔离双端组件验收与合同同步已实施。下列勾选表示该开发子项已实现，不等于复合 RH-AC 或生产门禁全部通过；实际证据与剩余项见 Checklist。

依据：[Spec](../product/runtime-request-health-spec-v1.md) | [Plan / 系统开发方案](../design/runtime-request-health-plan-v1.md) | [Checklist](../quality/runtime-request-health-checklist-v1.md)。

## 1. 执行方式与门禁

采用 SDD：先冻结需求和合同，以 Spec 的 RH-FR / RH-AC 编号编写失败断言，再按依赖实现，最后把真实证据填写到 Checklist。不能把当前旧测试通过或文档生成当作新功能完成。

- 任务初始为未完成；本轮按实际代码与定向证据更新子项。整项完成仍须 RH-AC 复合门禁证据，失败或未执行必须注明，不把“部分实现”标成整体完成。
- 优先使用 stub、协议 fixture、假时钟和隔离状态目录。推进 10/30 分钟阈值无需真实等待，不调用付费模型来制造心跳。
- 共享合同 → 纯策略 → adapter/监督 → 存储/API → 双端 → 故障矩阵依次进入门禁。遇到实际能力差异返回合同层补证据，不绕开 unknown_wait。
- 当前工作树存在其他专项修改；每项任务先检查 scoped diff，不回退、不整文件覆盖未知改动。
- 真实模型采样、生产迁移、更新 CLI、重启服务、提交、发布和部署须另行获得授权。本清单不授权这些外部动作。
- 不依赖思考开关、不新增 unknown 自动取消 TTL、不用 WAIT_USER_CONFIRM 或 pause/resume 代替未知等待。

## 2. 任务依赖与交付物

| 任务 | 交付物 | 前置任务 | 要求 / 验收 |
| --- | --- | --- | --- |
| T01 | 路径/计时器清单、能力矩阵、共享合同和协议 fixture | 无 | RH-FR01、03、12；RH-AC01、03、04、12 |
| T02 | 纯健康 reducer、去重和假时钟测试 | T01 | RH-FR01–05、07–09；RH-AC01–05、07–09、14 |
| T03 | Claude 本地/服务端增量观察与脱敏 | T01、T02 | RH-FR01、02、11；RH-AC01、02、07、11 |
| T04 | Codex exec/app-server 观察与能力降级 | T01、T02 | RH-FR01–03、11；RH-AC01–03、11、12 |
| T05 | 精确进程观察、只读 probe 与协议兼容 | T01、T02 | RH-FR03、09、11、12；RH-AC03、06、09、11–13 |
| T06 | Runtime/Local Runtime/runner/Worker 监督统一 | T02、T03、T04、T05 | RH-FR04、05、08、09；RH-AC04、05、08、09、13、14 |
| T07 | Generic LLM 普通/tool-loop 与 buffered 等待语义 | T02、T06 | RH-FR01、04、05、07、08；RH-AC01、04、05、07、08、14 |
| T08 | 有界异常恢复、格式纠正、预算与停止竞争 | T06、T07 | RH-FR06–09；RH-AC06–09、13、14 |
| T09 | 健康快照、API、事件/outbox、恢复与迁移 | T05、T08 | RH-FR05、06、09、10、12；RH-AC06、09、10、12、13 |
| T10 | Web/desktop 共享状态与等待/停止交互 | T09 | RH-FR05、06、10；RH-AC05、06、10 |
| T11 | 脱敏诊断、资源界限与配置校验 | T03、T04、T05、T07、T09 | RH-FR03、11；RH-AC02、03、11 |
| T12 | 全路径故障矩阵、兼容及存储/重启回归 | T08、T09、T11 | RH-FR01–12；RH-AC01–14 |
| T13 | 双端 E2E、构建与隔离更新/回退演练 | T10、T12 | RH-FR10、12；RH-AC10、12、13、15 |
| T14 | 合同/运行文档同步、追踪审查与验收交付 | T13 | RH-FR01–12；RH-AC01–15 |

前置关系代表工程门禁，不要求启动额外代理。任务标题和编号与 Plan、Checklist 一致。

## 3. 开发任务

### T01：冻结执行路径、证据与共享合同

- [ ] 清点所有模型入口、phase、timer、AbortController、Worker lease、工具硬限制及停止 owner；记录“观察阈值 / 已批准硬政策 / 真实基础设施错误”的分类，不凭现有默认值认定批准。
- [ ] 明确 local Claude/Codex、server Claude/Codex streaming/buffered、Generic LLM 普通/tool-loop、系统 RuntimeInvocation 的能力矩阵；确认实际 CLI 版本，不假定所有路径支持 reasoning/probe。
- [x] 新增 `packages/shared/src/runtime-request-health.ts`，定义 observation、snapshot、能力、原因、版本及 wait 请求/响应；扩展共享导出、Local Runtime 协商及事件/API 合同。
- [ ] 创建 thinking 开/关/隐藏、正文、工具、retry、未知、终态的最小脱敏 fixture；保留协议结构，不复制真实 prompt/思考内容。

落点：shared `runtime-activity.ts`、`local-runtime-contracts.ts`、`runtime-streaming/`、`docs/contracts/`；其余路径见 Plan 第 2 节。

验证：合同校验拒绝错误身份/版本/枚举；能力 unsupported 不被推断为错误；路径表包含所有 timer owner。输出合同差异表及 fixture 清单，RH-AC04 的覆盖表不能缺项。

### T02：实现纯健康策略与活动去重

- [x] 新增 `apps/server/src/common/runtime-health-policy.ts` 及定向测试；明确 stage、health、reason 转移，不在 reducer 中执行网络、数据库或模型调用。
- [x] 断言健康超预算不取消；静默仅未知；进程/心跳/active 不续模型进展；思考关闭不影响规则；终态/停止/generation 优先。
- [x] 使用接收端单调时间、observerEpoch、sequence、native event/item/block 标识；去重回放，同时允许两个内容相同但身份不同的合法增量。
- [x] 明确进展新鲜度到期后的观察，不以一次 reasoning start、历史完整消息或重复错误永久续期。

验证：假时钟跨越 10 分钟、30 分钟及原 deadline；比较 cancel/settle/apply 的调用次数；乱序、重复、时钟偏移及终态后 pulse 不改变结果。保留转换表与用例结果。

### T03：补齐 Claude 增量观察与隐私边界

- [ ] 修改 shared Claude parser 及本地/服务端 adapters，按能力启用 include-partial-messages；支持 stream_event 的 text、tool-input、thinking 活动及脱敏 api_retry。
- [x] 增量观察与最终 structured_output/result 分离；部分 JSON 不参与最终合同判定；partial 与最终完整消息不重复统计。
- [ ] thinking 只保留活动元信息；过滤 frame.raw、stdout/stderr 捕获、审计和持久化中的原始思考/签名，不以“UI 不显示”替代端到端脱敏。
- [ ] 自定义参数、旧 CLI 无 partial 或隐藏思考时使用真实能力降级；不修改用户思考配置、不自动重跑试参数。

落点：`packages/shared/src/runtime-streaming/claude-stream-json-parser.ts`、`frame-to-runtime-event.ts`、`packages/local-runtime-cli/src/adapters/claude-code-adapter.ts`、server Claude adapter/runner。

验证：开/关/隐藏、分块行、空 delta、相同 token、重复最终消息、一次 502 后进展、持久化脱敏；最终业务输出仍可正常校验。

### T04：补齐两条 Codex 路径

- [x] 本地 `codex-adapter.ts` 增加逐行 JSONL 观察；识别协议 fixture 的 turn/item/工具事件，不把最终文本捕获替换成不完整增量。
- [x] 服务端 `codex-frame-parser.ts` 归类 reasoning/正文/工具进展，仅生成脱敏活动；active/inProgress 不作为新进展，未提供 thread/read 查询时声明上游查询 unsupported。
- [x] exec 未提供请求查询时声明 unsupported；缺少 reasoning 不要求该事件；保留 unknown_wait，不强制迁移 app-server。

验证：exec/app-server 各自 stub，thinking 不可见、工具长运行、未知事件、真实失败终态、重复 item、旧 CLI 降级；不依赖真实模型请求。

### T05：进程实例与只读 probe

- [x] 在 `runtime-process.ts` / transport 登记精确 invocation、generation/epoch、随机进程实例和结束状态，不凭 PID 复用判断健康。
- [x] 扩展 shared Local Runtime 消息、transport、server connection，支持协商后的 probe/result；未声明能力的连接明确降级。
- [x] 每个 invocation 只允许一个待完成探测，全局最多 32；probe 超时只清理 probe，自身 AbortSignal 不关联模型任务。
- [x] 未匹配、旧 generation/epoch、迟到或跨设备响应不改变状态；不存在上游查询能力时返回 unknown，不另发测试 prompt。

验证：探测成功/unsupported/超时/重复/乱序/错误绑定；模型调用数始终为零；探测与停止同时发生不会复活调用。结束后 pending/listener/timer 清空。

### T06：统一外层与 CLI/Worker 监督

- [x] RuntimeService 消费统一策略；将 execution-budget-policy、Local Runtime idle、streaming watchdog、buffered runner 的自发时间取消改为观察。
- [ ] 系统 RuntimeInvocation、编排全阶段及 Worker 同策略；区分队列/启动预检/lease 失效与模型静默，不用另一个 phase timer 绕过策略。
- [x] 活动/未知 invocation 保留句柄、预留、并发槽与 worktree；不 settle、不调用 pause/resume、不自动释放后启动替代任务。
- [x] 连接断开记录控制异常并遵循可信停止/重连合同；未确认旧进程结束时不重试替代执行。

验证：为每个 timer owner 注入到期信号，断言健康及未知任务 cancel=0；覆盖本地与服务端、流式与 buffered、系统入口。显式用户取消/硬政策仍能到达真实取消路径。

### T07：消除 Generic LLM 内层误杀

- [x] 检查 `generic-llm-runtime.service.ts` 普通请求与 tool-loop 每次 fetch 的 absolute AbortController，模型等待时改为观察；保留用户取消及真实网络/供应商失败。
- [ ] 记录内部 requestAttemptId、请求开始/结束、工具活动及支持的 body 进展；非流式请求允许未知，不强制换协议/模型。
- [x] 正常工具轮转属于原 invocation，不重置操作预算；每个内部请求可独立静默观察。启动前 models/preflight 保留独立准入语义。

验证：未返回 headers、已返回 headers 未返回 body、buffered 长响应、正常 tool-loop、明确 HTTP/连接失败；跨越旧内层 timer 后仍是同一 AbortSignal 和 invocation，用户 stop 仍能中断。

### T08：异常恢复、预算与可信停止

- [x] 真实错误与静默/探测失败分离；瞬时 retry 不直接宣告永久失败，也不成为进展；有限退避/attempt/allowlist/circuit 继续生效。
- [ ] deadline/attempt/Token/费用账本不回填；未知等待不增加额度；已耗尽预算不得启动新的平台调用或异常恢复请求。
- [x] StructuredOutput guard 的非法提交与修复等待分开：一次纠正额度保留，等待阈值转观察，实际失败/纠正耗尽仍失败；普通工具阈值与批准硬上限分开。
- [x] 停止复用现有 termination、预留与屏障；准确呈现 Session 全部停止；保留可信 process-end 和 generation fence。
- [x] 未请求停止的未知调用结果应用一次；stop/替换后迟到结果只核对结束，不写业务内容、不自动启动新调用。

验证：单次 502 恢复、持续失败耗尽、真实 provider timeout、CLI 不可见重试、预算到期后的成功/修复、stop/result 竞争、停止未确认、generation 替换和重复回执。

### T09：快照、API、事件与存储恢复

- [x] 实现 Plan 第 8 节 GET health / POST wait：既有安全边界、调用归属、expectedVersion、generation 和幂等校验；wait 只确认选择，不复用 resume。
- [x] 实现 runtimeHealthBySession 及单调状态版本；状态转换与 outbox 原子提交，合并频繁 pulse，不逐 token 写库；锁内不探测。
- [x] 同步 file/PostgreSQL schema、关系映射、migration v21、cutover/replace-state；真实 PostgreSQL 验证独立待执行。
- [x] 保存失败进入有限辅助重试/待同步，不重跑或取消健康任务；恢复后的历史健康降为未知，无操作权限；匹配可信停止账本可收尾，不自动复活调用。

验证：两种存储后端、outbox 重复/丢失/乱序、保存失败、跨会话访问、版本冲突、wait 重复、重启与旧记录。模型调用/attempt/预算在 health/wait API 前后不变。

### T10：双端健康提示与用户操作

- [x] Web store/API 与 desktop 复用健康模型，现有执行区域呈现未知、进展、重试、停止和终态，不新增顶部导航。
- [x] 未知展示原调用保留、最后进展/等待时间及可观测能力；提供继续等待和语义准确的停止按钮；busy 防重复提交。
- [x] 不修改 SessionStatus 为 FAILED/PAUSED/WAIT_USER_CONFIRM；快照 + SSE 按 version/generation/epoch 合并，旧事件不回退状态。
- [x] 多 Agent 按 invocation 展示；查询失败/页面断线显示观测不可用，不能覆盖可信终态或取消服务端任务。

验证：Web/desktop、刷新/重连、并发调用、旧 SSE、未知→进展→终态、点击等待/停止；等待不产生模型请求，按钮焦点/禁用/错误反馈可用。

### T11：资源、诊断与配置

- [ ] 实施有限默认观察参数、配置校验、通知冷却、单调用/全局 probe 限流及缓存/日志/写入频率上限；观察参数不产生取消 TTL。
- [ ] 诊断记录各层最后证据、reason、身份和 policyVersion，不含 prompt、凭据、思考正文/签名；指标使用低基数标签。
- [ ] 长未知保留原槽位/工作区；日志截断或诊断缓存满不能伪装为模型失败；显式批准的资源硬政策走独立 policy_limit。
- [ ] 完成/取消后清理定时器与监听器；暴露真实模型/平台请求计数，probe 不计作模型活动。

验证：加速长等待、成批并发未知、恶意大事件、重复 retry、无效配置、完成后泄漏检测；诊断能解释每次转移且无敏感内容。

### T12：故障矩阵、兼容与重启测试

- [ ] 落实 Checklist 全部确定性场景，跨所有 provider 路径和业务阶段建立覆盖表；不得仅测成功输出路径。
- [ ] 验证旧 CLI/probe 不支持、协商失败、source/build 差异、file/PostgreSQL 后端一致性。
- [ ] 注入 server/CLI/Worker 重启、断线重连、进程退出、错误绑定、保存/outbox 失败；不凭旧 running/PID 自动重跑。
- [x] 更新原先“静默必取消”的测试预期，同时保留用户取消、权限、可信结束、硬政策、格式纠正和安全回归。

验证：每个 RH-AC01–14 有场景、断言和结果；未覆盖路径明确阻塞本专项验收，而不是写为“不适用”。用隔离 fixtures，不接生产数据库。

### T13：双端 E2E、构建与更新演练

- [ ] 拟新增专项请求健康 stub E2E，覆盖长等待、用户选择、真实错误、停止竞争和多 Agent；同一场景验证 Web/desktop。
- [x] 运行相关定向测试、全工作区类型检查/构建及必要回归；准确记录并行改动导致的失败。侧栏阻挡经用户另行批准修复，未回退其他并行代码，证据见 Checklist V9。
- [ ] 在隔离实例验证启动冻结 policyVersion、实际构建加载、兼容迁移和回退；在途未知任务不热切回旧 kill timer、不重放模型。
- [x] 编写实际部署前的活动任务清点与批准门禁；本任务不自动执行生产重启或灰度。

验证：RH-AC15 的全部门禁有命令、环境、退出码和报告；任何真实采样/生产更新未授权时标待批准，不声称已经验证上线。

### T14：追踪审查、合同同步与交付

- [x] 更新 Runtime、事件、API、UI 状态与运维合同中的旧 timeout 语义，说明观察阈值和批准硬政策区别；不覆写旧历史验收结果。
- [ ] 核对 RH-FR01–12 → T01–14 → RH-AC01–15 双向覆盖及测试路径，移除代码/文档语义冲突。
- [x] Checklist 填写真实证据，未执行项保持未勾选；清晰区分“代码候选 / 隔离验收 / 生产加载”。
- [ ] 审查 diff 范围、停止安全、隐私、资源、能力降级、更新/回退门禁，交付已知限制和剩余参数。

完成条件：需求均被验证、缺陷已处理、证据可复查；如还缺双端/后端/更新证据，不标整个专项完成。

## 4. 验证入口与证据要求

现有命令、实际专项测试文件与结果见 [Checklist](../quality/runtime-request-health-checklist-v1.md#5-验证命令与执行约束)。没有新增全矩阵 smoke 脚本，不把双端组件 fixture 伪称为完整系统 E2E。

每项记录：Task / RH-AC、变更文件、fixture/测试名称、命令、隔离环境、UTC 时间、退出码、报告位置、失败原因或待批准动作。日志与报告需脱敏。本轮运行了共享、CLI、后端、Web、Desktop 与 Harness 回归及构建；结果不是生产加载证明。

## 5. 剩余开发与门禁（不能以勾选子项覆盖）

T01/T03：真实 CLI 版本/partial 参数兼容预检与全面隐私输出矩阵。T06/T12：Worker lease/重启及所有 provider × 故障 × phase 的贯通矩阵。T07/T08：Generic 每个内部请求的 requestAttemptId/结束关联与完整账本审查。T11：独立通知冷却、全局历史/待同步容量与资源压力/泄漏/低基数指标。T09/T12：实际隔离 PostgreSQL roundtrip/迁移/cutover/备份。T13：renderer 构建阻挡已解除，仍需请求健康专项的打包 Electron 贯通验收及隔离升级/回退。T14：这些门禁通过前不标整个专项完成。

## 6. 明确故障预算兜底补丁任务（2026-09-29）

本轮只关闭下列补丁子项，不勾选整个 T01–T14 或 RH-AC01–15；验收证据见 Checklist 第 10 节。

- [x] RH-P01（T02/T08；AC03/07/08）：先写失败回归，复现 retry 被 tick/probe/请求确认清除及预算遗漏错误编码。
- [x] RH-P02（T02/T06/T08；AC02/07/08）：统一 shared 事件分类、黏性异常 reducer 和 live snapshot 预算判断；保留原截止及未知等待。
- [x] RH-P03（T02/T08；AC07/08/09）：分离格式纠正，保留控制断线/进程退出，防止旧工具回执/失败或迟到活动掩盖 provider 故障。
- [x] RH-P04（T09/T11；AC10/11/12）：使用可选脱敏诊断字段及既有原子状态事件，不因健康保存失败重跑或取消模型。
- [x] RH-P05（T10；AC10/11）：共享双端面板补充用户可读的限流、连接中断、纠正和预算停止解释，终态不误称仍在恢复。
- [x] RH-P06（T06/T12；AC03/09/12）：按当前连接协商初始化 probe 能力；stub 验证零额外模型请求、一次停止及迟到成功屏障。
- [x] RH-P07（T14）：同步本四件套和 Runtime 合同，保留之前的失败/通过记录及未完成门禁。
- [ ] RH-P08（T13；AC15）：清点真实活动/停止未确认调用，经用户批准安全更新后端与 Runtime，并核验运行进程确实加载目标构建及协商能力。当前不执行。
