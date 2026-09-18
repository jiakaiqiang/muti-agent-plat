# 主 Agent 协作与长会话治理：分阶段实施总计划 v1

> 日期：2026-09-16
> 状态：阶段 0、阶段 1、阶段 2A、阶段 2B、阶段 2C 与阶段 3 已实现并验收；阶段 4 及后续业务接入待实施。
> 初始文档交付：1 份总计划 + 9 阶段 × 4 份文档，共 37 份新增文档，记录保留于第 11 节。
> 当前已验收范围：阶段 0、阶段 1、阶段 2A、阶段 2B、阶段 2C、阶段 3；未调用真实付费/多模态 Provider、部署或发布。

## 1. 目标与已沟通决定

将群聊改造成“主 Agent 主持 + 专家按需协作 + 用户确认 + 已选工作流执行”的受控多 Agent 协作系统，不是专家自由扩散、自主改图的 Agent 蜂群。

- 用户提出需求后，由主 Agent 理解需求、组织专家讨论并给出实质综合结果。
- 用户可以在讨论中 @ 指定 Agent 补充要求；专家可见回复需回到主 Agent 的话题与汇总链路。
- 主 Agent 可在当前已选成员内邀请专家协助；新增/替代成员先让用户确认，不能自行扩员。
- 所有正式需求文档、用户澄清与需求确认由主 Agent 统一对接，专家建议不等于用户批准。
- 先聊清楚并确认需求，再由用户选择 Web 管理端发布的流程。桌面流程管理仅查看/使用，主 Agent 不改用户选择的图。
- 执行中提问、补充和新需求由主 Agent 接收；简单问题直接处理，需要协作时选择专家；改变范围必须先说明影响并让用户选择。
- 一个 Agent 定义可被多个会话复用，但运行句柄、上下文、取消、队列和 CLI 历史按会话/需求隔离。
- 停止是停止当前执行并保留可恢复状态，不是撤销文件修改；删除先停稳后可恢复隐藏，不删共享源码和未合并产物。
- 会话历史长期保留不等于每次全部发送给模型。需求独立上下文、有效决策、增量摘要、按需召回与完整 Token 预算共同解决长会话问题。
- 缓存降低重复计算/输入处理成本，不增加模型窗口，也不代替上述边界。

## 2. 总体业务流转

1. 用户消息持久化并记录需求目标、回复对象和 @ 成员。
2. 确定性控制动作优先；普通消息通过有界意图识别，校验目标、版本与状态。
3. 主 Agent 直接回答，或形成有预算/退出条件的讨论计划并委派专家。
4. 专家返回结论、依据、风险和待澄清项；主 Agent 汇总，有缺口则统一问用户。
5. 主 Agent 发布当前需求的版本化文档；用户查看文档/差异并确认确切版本。
6. 用户选择已发布工作流；服务端校验版本、角色映射、目录授权、预算和停止屏障后唯一启动。
7. 工作流按选定图执行开发、验证与返工，主 Agent 统一解释进度、问题和结果。
8. 执行中的补充先分流；范围变更经选择、停稳、修订、重确认，新需求独立排队。
9. 阶段/需求结束或达到预算阈值时更新检查点；历史按需召回，不全量注入后续需求。

停止、删除、生命周期版本与预算是贯穿上述步骤的底层约束，不等到工作流执行阶段才启用。

## 3. 现有能力、差距与复用原则

| 区域 | 当前代码事实 | 本专项改造方向 |
| --- | --- | --- |
| 意图入口 | 已有 MessageIngress、精确命令、SemanticIntentRouter、RouteApplication | 扩展 @ / 回复 / 有界历史候选，统一初次与后续消息，不重建第二套路由 |
| 需求与决策 | 已有 WorkItem、DecisionRecord、版本快照和显式继承 ID | 作为唯一需求事实，严格区分摘要与批准 |
| 讨论 | 已有参与者咨询、轮次和 boundedConsultations | 加入持久化话题/委派、主 Agent 实质汇总及动态用户补充 |
| 持久化与停止 | 已有 scoped mutation、LogicalOperation、SessionStopStateStore 与专项验证记录 | 复用并覆盖新增后台工作、删除准入和迟到回调 |
| 删除 | 现有 Sessions.delete 停止后清理目录与记录，最终物理 purge | 改为可恢复生命周期；普通删除不再触发物理清理 |
| 记忆 | 已有摘要检查点和关键词记忆检索 | 增量、版本化、来源校验、旧决定替代、有界历史召回 |
| Token | 已有估算、层级预算和输入门禁，基础估算为字符数/4 | 完整 adapter 请求/工具循环计数与跨并发累计预算 |
| 缓存 | 已有 workspace revision 索引缓存及部分 Claude 缓存用量解析 | 分层 key、失效/回填保护、容量上限、按 Runtime 适配与真实成本观测 |
| 工作流与双端 | 已有流程版本/运行、返工、共享 stores 与独立桌面 renderer | 版本化文档确认后交接已选图，保持两端独立样式 |

证据入口：

- [共享合同](../../packages/shared/src/contracts.ts)
- [消息入口](../../apps/server/src/modules/message-routing/message-ingress.service.ts)
- [上下文管理](../../apps/server/src/modules/context-management/context-management.service.ts)
- [群聊编排与摘要](../../apps/server/src/modules/orchestrator/orchestrator.service.ts)
- [会话生命周期入口](../../apps/server/src/modules/sessions/sessions.service.ts)
- [Token 工具](../../apps/server/src/common/token.ts)
- [停止状态存储](../../apps/server/src/modules/runtimes/session-stop-state-store.ts)
- [已有持久化验收](../quality/session-persistence-recovery-checklist-v1.md)
- [已有停止验收](../quality/runtime-stop-consistency-checklist-v1.md)

旧专项的“通过”不自动代表本专项通过。阶段 0 已按[本轮基线](../implementation/main-agent-collaboration-phase-0-baseline-v1.md)重新验证相关合同/停止/意图/持久化测试，具体范围见[验收记录](../quality/main-agent-collaboration-phase-0-checklist-v1.md)。项目地图中的历史状态可能滞后，实施以当前代码及新验证证据复核，保留既有修改。

## 4. 更新后的阶段表与 SDD 入口

原阶段 0～6 保留；原阶段 2 扩展为 2A、2B、2C，因此共 9 个验收阶段。

| 阶段 | 交付重点 | 前置条件 | 四份文档 |
| --- | --- | --- | --- |
| 0 | 合同收敛、现状基线与迁移边界（已完成合同/基线验证） | 无 | [spec](../product/main-agent-collaboration-phase-0-spec-v1.md) · [plan](../design/main-agent-collaboration-phase-0-plan-v1.md) · [tasks](../implementation/main-agent-collaboration-phase-0-tasks-v1.md) · [checklist](../quality/main-agent-collaboration-phase-0-checklist-v1.md) |
| 1 | 多会话执行隔离、停止与可恢复删除（已完成并通过验收） | 0 | [spec](../product/main-agent-collaboration-phase-1-spec-v1.md) · [plan](../design/main-agent-collaboration-phase-1-plan-v1.md) · [tasks](../implementation/main-agent-collaboration-phase-1-tasks-v1.md) · [checklist](../quality/main-agent-collaboration-phase-1-checklist-v1.md) |
| 2A | 统一消息意图、需求隔离与完整 Token 预算（已完成并通过验收） | 1 | [spec](../product/main-agent-collaboration-phase-2a-spec-v1.md) · [plan](../design/main-agent-collaboration-phase-2a-plan-v1.md) · [tasks](../implementation/main-agent-collaboration-phase-2a-tasks-v1.md) · [checklist](../quality/main-agent-collaboration-phase-2a-checklist-v1.md) |
| 2B | 版本化长期记忆、增量摘要与历史需求召回（已完成并通过验收） | 2A | [spec](../product/main-agent-collaboration-phase-2b-spec-v1.md) · [plan](../design/main-agent-collaboration-phase-2b-plan-v1.md) · [tasks](../implementation/main-agent-collaboration-phase-2b-tasks-v1.md) · [checklist](../quality/main-agent-collaboration-phase-2b-checklist-v1.md) |
| 2C | 分层缓存、失效治理与成本观测（已完成并通过验收） | 2B | [spec](../product/main-agent-collaboration-phase-2c-spec-v1.md) · [plan](../design/main-agent-collaboration-phase-2c-plan-v1.md) · [tasks](../implementation/main-agent-collaboration-phase-2c-tasks-v1.md) · [checklist](../quality/main-agent-collaboration-phase-2c-checklist-v1.md) |
| 3 | 主 Agent 主持讨论与可恢复专家协作（已完成并通过验收） | 2A/2B/2C | [spec](../product/main-agent-collaboration-phase-3-spec-v1.md) · [plan](../design/main-agent-collaboration-phase-3-plan-v1.md) · [tasks](../implementation/main-agent-collaboration-phase-3-tasks-v1.md) · [checklist](../quality/main-agent-collaboration-phase-3-checklist-v1.md) |
| 4 | 主 Agent 文档、精确确认与所选工作流交接 | 3 | [spec](../product/main-agent-collaboration-phase-4-spec-v1.md) · [plan](../design/main-agent-collaboration-phase-4-plan-v1.md) · [tasks](../implementation/main-agent-collaboration-phase-4-tasks-v1.md) · [checklist](../quality/main-agent-collaboration-phase-4-checklist-v1.md) |
| 5 | 执行中补充、新需求与范围变更治理 | 4 | [spec](../product/main-agent-collaboration-phase-5-spec-v1.md) · [plan](../design/main-agent-collaboration-phase-5-plan-v1.md) · [tasks](../implementation/main-agent-collaboration-phase-5-tasks-v1.md) · [checklist](../quality/main-agent-collaboration-phase-5-checklist-v1.md) |
| 6 | 双端综合验收、长会话成本评测与受控上线 | 全部前置阶段 | [spec](../product/main-agent-collaboration-phase-6-spec-v1.md) · [plan](../design/main-agent-collaboration-phase-6-plan-v1.md) · [tasks](../implementation/main-agent-collaboration-phase-6-tasks-v1.md) · [checklist](../quality/main-agent-collaboration-phase-6-checklist-v1.md) |

默认执行次序：0 → 1 → 2A → 2B → 2C → 3 → 4 → 5 → 6。先保证隔离、预算和记忆，再扩大主 Agent 协作能力；不能以缓存可用替代基础正确性。

每组文档的作用：

- Spec：目标、范围、非目标、代码依据和带 ID 的验收条件。
- Plan：数据/状态/事务/接口设计、落点、取舍、风险与回退。
- Tasks：有序任务、依赖、交付物及关联 AC。
- Checklist：具体场景、预期、现有命令、必须新增的测试和证据位置。

本专项共 61 条阶段 AC、54 项开发任务。阶段 0、阶段 1、阶段 2A、阶段 2B、阶段 2C 与阶段 3 的 40 条 AC、36 项任务已完成实现和验收；阶段 4 及以后仍待实施/待验证，不因前置阶段通过而自动完成。

## 5. 跨阶段架构决策与不变量

| 决策 ID | 决策 | 后果/边界 |
| --- | --- | --- |
| D01 | 主 Agent 复用受保护 coordinator 系统角色 | 不新增第二调度者；专业建议与最终用户确认职责分离 |
| D02 | Intent Router 只输出可校验建议 | 精确命令走确定性入口，分类不直接改状态、不获得工具授权 |
| D03 | Session 容纳多个 WorkItem | 当前任务只带自身和显式继承上下文，不能遍历后全量注入 |
| D04 | 确认绑定需求、文档与流程输入快照 | 旧卡片不批准新版本，重复点击不能重复启动 |
| D05 | 执行按 session/workItem/run/operation/invocation 隔离 | Agent 配置可共享，执行状态与私有缓存不可共享 |
| D06 | 停止/删除先关闭准入，可信停稳后推进 | 未知停止状态不放行；普通删除保留源码/产物和审计 |
| D07 | 原始记录、权威事实、派生摘要分层 | 摘要可重建但不能覆盖用户决定；缓存过期不删除业务事实 |
| D08 | 最终请求预算 + 需求累计预算 | 包含路由、专家、摘要、补读、重试及工具循环，不只统计聊天正文 |
| D09 | 缓存 key 与失效绑定真实业务依赖 | 心跳不全量失效；需求/文件改变后不能复用旧结论 |
| D10 | 新功能只有一个权威业务入口 | 复用现有 v2-only、领域服务、outbox；不创建平行状态机互相回写 |
| D11 | 同会话首版一个活动开发工作流 | 其他需求可独立讨论/排队但不并发写项目；多会话仍按既有隔离设计并行 |
| D12 | 两端共享 API/store/events，页面呈现独立 | 不把桌面三栏样式覆盖 Web；保留聊天通知、进度、只读文件 Diff 与流程目录约束 |

主 Agent/专家均只能调用当前已授权能力；这次不实现开放注册和权限认证。项目文件或历史聊天里的指令不应升级为系统指令。

讨论及文档草稿可以保存为受控 artifact；这不授权修改工作区源码或执行开发命令。流程模板发布更新不自动迁移已经锁定版本的运行。

## 6. 上下文与缓存专项落地约束

1. 只读当前需求状态、有效决策、有限近期对话、当前任务和相关证据；完成需求归档后不默认携带其摘要。
2. 检查点绑定覆盖消息范围、需求/决策版本、来源和策略版本；重复生成只允许一次有效提交，旧版本回填拒绝。
3. 旧决定通过 supersedes/状态替换失效，不靠关键词摘要同时保留新旧约束。
4. 历史召回先检索候选再读取正文，歧义让主 Agent 澄清；检索失败不等同不存在。
5. 缓存分文件索引、摘要、上下文包、模型前缀四类；命中后仍执行权限/生命周期与 Token 校验。
6. Provider 缓存仍占上下文窗口；本地缓存不直接等于模型输入折扣。压缩可能降低前缀命中，应比较总成本而非只看命中率。
7. 应用上下文与 CLI 内部会话都需受控；跨需求不复用同一无限增长的 CLI 历史，轮换不重播已完成副作用。
8. 历史查询分页、派生缓存有容量上限；不能模型侧变小但后端每次仍全量装载所有正文。

供应商缓存行为只作为适配参考，实施时按实际模型/接口重新核对，不把参数/计费写成统一保证：

- [OpenAI 提示词缓存官方文档](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Claude 提示词缓存官方文档](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Claude 上下文窗口说明](https://platform.claude.com/docs/en/build-with-claude/context-windows)

## 7. 参数、假设与需要单独确认的操作

现有产品讨论足以生成这些 SDD 文档，不再要求用户重复确认已讨论内容。以下数值/运行操作不在本轮擅自决定：

| 项目 | 本计划处理 |
| --- | --- |
| 生产输入/输出/累计费用预算 | 建立可配置合同；按实际模型窗口和已有账户能力设置，生效值写入运行策略快照 |
| 讨论并发、轮次、超时、摘要阈值 | 有界且可配置；实施入口校验，重试不得绕过累计预算 |
| 缓存容量/TTL、语义检索实现 | 优先现有设施，参数可调；不默认采购外部服务或导出历史数据 |
| 可恢复删除保留期 | 本期不启用自动物理清理；保留数据，后续清理另行确认 |
| 存量活动会话 | 维持原策略快照；停稳/完成后再升级，不自动重跑 |
| 数据库迁移/服务重启/发布/真实模型评测 | 先隔离演练，涉及运行环境的高风险操作单独征求确认 |

共享类型/基本参数合同已在[阶段 0 合同](../contracts/main-agent-collaboration-contract-v1.md)冻结并提供纯校验；API、存储与业务入口仍明确为 deferred，不得当成现成能力调用。未新增生产环境变量或默认启用开关。

## 8. 验证策略与阶段门禁

所有阶段按“需求 AC → 实施 Task → 测试场景 → 实际证据”追踪。先确定性 fixture、合同/单测，再 file 与独立 PostgreSQL、隔离 CLI stub，最后双端 E2E。

综合验收最低覆盖：

- 同 Agent、同设备的两个会话；停止/删除 A 不影响 B。
- 用户中途 @、成员外邀请、专家冲突/超时、主 Agent 失败恢复。
- 文档/需求/流程版本变化，双端重复与过期确认，启动提交后崩溃。
- 执行中状态询问、范围变更、暂停修订、新需求排队及质量拒绝返工。
- 同会话 100 需求/至少 1000 消息，早期需求召回、歧义与约束修订。
- 同一当前任务附加 10/100 个无关历史需求，受控最终输入增长不超过 1.2 倍且始终在配置上限内；这是本专项验收目标，不是当前测得结果。
- 缓存命中/失效/容量/回源故障、摘要并发提交、迟到回填和取消删除。
- 双端 SSE 乱序/断线/刷新收敛，界面分别对照各自基线。

身份泄漏、未经确认执行、重复副作用、过期批准、未知停止放行、删除后复活任一出现即禁止上线。固定标注验收集全部通过不代表可宣称模型在所有真实输入上 100% 准确。

现有根命令及各阶段定向入口见 Checklist。业务 E2E/模型测试实施前检查目标环境；未测不得标绿。真实模型抽样须另定模型、数据和费用范围。

## 9. 迁移与回退总规则

采用加法字段/表/索引迁移，不清库、不复活已退役 dataEpoch、不恢复 v1 Context Pipeline。现有物理删除改造需特别审核所有入口及后台清理器。

每次切换前：核对活动任务 → 隔离迁移/恢复演练 → 兼容代码部署 → 新会话准入启用 → 验收后扩大。操作发布需另行授权，本轮没有部署动作。

回退先关闭新的准入，保留墓碑、停止屏障、决策版本、预算、检查点和运行记录；旧构建无法理解新数据时向前修复，不通过删除记录或清空状态解除阻塞。

## 10. 与既有文档关系

- 本计划将本次沟通的主 Agent、动态讨论、多会话安全和长会话缓存需求作为后续改造目标，替代此前聊天中的粗粒度阶段说明。
- [意图/WorkItem 目标设计](../design/intent-context-workitem-system-agent-target-design-v1.md) 与其已实现模块继续复用；与本次主 Agent 用户沟通职责不同处，由本计划阶段 0 收敛合同，不盲目重做旧任务。
- [v2-only 系统设计](../design/context-pipeline-v2-only-agent-decoupling-system-design-v1.md) 和 [工作区多会话隔离](../design/workspace-multi-session-isolation-writeback-v1.md) 的安全边界继续有效。
- [工作流质量拒绝与返工](../product/workflow-quality-rejection-rework-spec-v1.md)、[桌面工作区](../product/codex-style-multi-agent-workspace-spec-v1.md) 及持久化/停止专项作为依赖和回归依据，未被本次文档重新标为已完成。
- Harness Engineering 仅约束本次工程交付方式，不作为产品模块引入。

## 11. 初始文档交付记录（历史记录）

- 已生成各阶段 Spec/Plan/Tasks/Checklist，开发项保持待实施/待验证。
- 已将长会话、累计预算、缓存失效与真实成本观测纳入前置阶段，不留到最后做性能优化。
- 仅做文档链接/追踪/格式与仓库文档规则验证；业务代码、真实模型、生产数据库与运行服务不在本轮执行范围。

本轮文档验证结果（2026-09-16）：

- 37 份文档完整；9 阶段、61 条 AC、54 项任务的双向引用检查通过。
- 298 个文档内本地链接、候选修改路径和 npm 脚本名称检查通过。
- `npm run test:harness` 通过，退出码 0；这是仓库工程规程/文档合同检查，不是新增业务功能验收。
- 文档格式/空白检查通过；未运行完整业务单测、E2E、真实模型、迁移或构建，因为本轮只写文档。

## 12. 阶段 0 实施交付（2026-09-16）

- 按用户确认先实施阶段 0，新增共享身份/职责/确认/生命周期/策略快照合同与纯校验，未接入服务端业务流程。
- 新增[冻结合同](../contracts/main-agent-collaboration-contract-v1.md)、[现状/迁移基线](../implementation/main-agent-collaboration-phase-0-baseline-v1.md)，同步合同索引、四件套及阶段 1 交接引用。
- 新增 15 项合同单测、6 项文档追踪检查；shared 全量 107、后端定向基线 40 全部通过；全仓类型检查、Harness、shared 构建通过。
- [阶段 0 Checklist](../quality/main-agent-collaboration-phase-0-checklist-v1.md)记录实际证据与未执行项目。本次没有把后续阶段业务验收、迁移/回退、双端 E2E 或真实模型测试标为通过。

## 13. 阶段 1 实施交付（2026-09-16）

- 完成持久化 Session 生命周期、generation 准入、可信停止屏障、可恢复删除与显式恢复。
- 普通执行、队列、工作流、Runtime 后处理、Memory、Workspace Writeback 和 LogicalOperation 均阻止旧 generation 迟到写入。
- Web 与 Desktop 共用生命周期事实，分别保留自身样式并提供已删除会话查看/恢复入口。
- [阶段 1 Checklist](../quality/main-agent-collaboration-phase-1-checklist-v1.md)记录 PostgreSQL 竞争、三项 E2E、全量测试、类型检查和构建证据；未调用真实模型，未部署或发布。

## 14. 阶段 2A 实施交付（2026-09-17）

- 完成统一消息入口、Intent Snapshot/WorkItem 隔离、确定性命令优先和跨并发 WorkItem 累计预算。
- Runtime 最终请求、工具循环、取消迟到结算和用户缩小需求恢复均进入同一预算与 lifecycle 边界。
- [阶段 2A Checklist](../quality/main-agent-collaboration-phase-2a-checklist-v1.md)记录定向、PostgreSQL、E2E 和全仓门禁证据；预算耗尽不再伪装成普通重试失败。

## 15. 阶段 2B 实施交付（2026-09-18）

- 完成版本化 SummaryCheckpoint、跨实例唯一提交、迟到版本拒绝及当前有效 DecisionRecord 派生；superseded 决策只保留来源回查，不再进入当前上下文。
- 完成 WorkItem 有界历史召回、相似项澄清、事件分页/32 页 LRU，以及 CLI 按 WorkItem/generation 隔离与受控轮换。
- [阶段 2B Checklist](../quality/main-agent-collaboration-phase-2b-checklist-v1.md)记录 176/176 定向回归、独立 PostgreSQL 11/11、六条关键 E2E 和全仓门禁。
- 已知边界：file backend 启动仍加载完整 JSON/事件投影；本阶段不把请求级分页描述成存储完全懒加载。未调用真实付费模型、部署或发布。

## 16. 阶段 2C 实施交付（2026-09-19）

- 完成缓存与用量合同（分层 key、私有/公共作用域、依赖指纹、`normalizeRuntimeUsage`）、有界派生缓存（LRU/TTL、读取与回填双重 generation 校验）、进程内 single-flight 与按 key 熔断。
- 上下文包层（navigation + project map）接入真实调用方；三条 runtime 路径（generic-llm / claude_code / codex）的 usage 归一化统一，缓存计数不再在 runner 处丢失，未知用量一律 `unknown` 不伪装为零；结算按 `logicalInputTokens` 计入需求预算。
- 命中率经 `context_bundle_cache_total{layer,outcome}` 暴露于既有 ops 指标出口，标签不含会话 id。
- [阶段 2C Checklist](../quality/main-agent-collaboration-phase-2c-checklist-v1.md)记录原语级用例、四门禁与新增 E2E `test:e2e:context-bundle-cache`：真实服务上同一会话的缓存命中仍被发送前预算守卫拒绝（AC1）。
- 已知边界与延后：文件/摘要层不再套派生缓存、CLI 内建缓存能力声明不记录、跨进程 single-flight 延后（理由见 tasks）；`priceVersion` 来源与真实付费模型抽样归入阶段 6 P6-T5 成本报告。未调用真实付费模型、部署或发布。

## 17. 阶段 3 实施交付（2026-09-19）

- 完成持久化 DiscussionRun / Delegation 生命周期（PostgreSQL V13 `discussion_runs`，跨实例同键只留一条委派、旧修订拒绝不落盘、终态不可回退、重放幂等）。
- 主 Agent 以新 `discussion_plan` 输出提议，领域校验后落实：只咨询被点名的已选专家；目录内非成员生成用户确认卡而非自行加入；未知名字报出不编造；模型无法通过多余字段声明成员或批准。
- 专家失败只标该委派、整场继续；重启续跑只运行未完成项且不重问计划；停止时 run 暂停、委派保留可续；用户 @ 成为有归属的 `user_mention` 委派；需求修订就地 supersede 旧委派并在同一 run 重规划。
- 每轮以确定性综合收口：署名逐条、不写"一致同意"、冲突 = 同问题不同结论列为待选、失败/未回复点名、`sourceDelegationIds` 可核验；有未决时主 Agent 持有一张 `discussion_clarification` 卡。
- [阶段 3 Checklist](../quality/main-agent-collaboration-phase-3-checklist-v1.md)记录 120 余例单测、PostgreSQL 临时库 12/12、E2E `test:e2e:planned-discussion` 两场景与四门禁。
- 已知边界与延后（归阶段 4）：双端专用呈现未做（复用既有事件类型渲染）；扩员卡与澄清卡的选项处理未接；`blocked` 委派状态无写入方；新路径由 `MAIN_AGENT_DISCUSSION_ENABLED` 闸控、默认关。跨实例 CAS 延后。未调用真实付费模型、部署或发布。
