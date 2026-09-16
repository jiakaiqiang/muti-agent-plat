---
artifact: task_plan
stage: planning
producedBy: coordinator
schemaVersion: "0.1"
status: ready
deliveryId: agent-execution-reliability-v1
createdAt: 2026-09-14
designPlanRef: agent-execution-reliability-plan-v1
---

# Tasks：Agent 执行可靠性与调用效率修复

[Spec](../product/agent-execution-reliability-spec-v1.md) · [Plan](../design/agent-execution-reliability-plan-v1.md) · [Checklist](../quality/agent-execution-reliability-checklist-v1.md)

## 1. 执行约定

用户已授权实施，2026-09-14 已完成下表代码范围和隔离验证；真实模型采样保持待验。责任是模块职责，不是创建或委派子 Agent 的指令。详细任务清单与最终证据分开维护，验收以 Checklist 为准。

- 每项行为修复先建立能揭示缺陷的定向用例，再实现、验证、记录证据。
- 现有工作树有大量未提交修改；先核对归属和差异，复用已有停止/纠正/返工实现，不回滚或覆盖无关变更。
- 不以本文件的勾选替代 Checklist 的 AC 证据；实现完成、隔离验证、真实模型效果分别记录。
- 允许修改范围为每项 allowedPaths 和直接配套测试、对应合同。发现需要新业务范围先修订设计，不顺手扩展。
- 全局 forbiddenPaths/行为：用户真实工作目录、凭据与真实 `.env`、既有工作流快照、用户任务数据、Web/桌面全局重设计、认证模块、真实服务重启、付费采样、提交发布部署。
- 合同变更限定本功能字段，配套 `docs/contracts/{data,runtime,event,api,ui-state}-contract-v0.1.md` 按实际实现更新；不提前将 proposed 写成已运行。

## 2. 依赖与批次

| 任务 | 批次 | 依赖 | 规格 | AC | 状态 |
| --- | --- | --- | --- | --- | --- |
| T0 | 基线 | 无 | REL-001–013 | AC01–18 的验证准备 | done；历史观测未重放 |
| T1 | 第一批 | T0 | REL-001、REL-002、REL-011 | AC01、AC02、AC03、AC14 | done |
| T2 | 第一批 | T1 | REL-003、REL-004、REL-011 | AC04、AC05、AC06、AC14 | done；未知工程进程安全停车 |
| T3 | 第一批 | T2 | REL-005 | AC07 | done |
| T4 | 第二批 | T2、T3 | REL-006、REL-007 | AC08、AC09 | done |
| T5 | 第二批 | T4 | REL-008 | AC10 | done |
| T6 | 第二批，联合第三批验收 | T2、T5 | REL-009、REL-011 | AC11、AC14 | done；自动修复能力边界见 Plan §9 |
| T7 | 贯穿各批 | T2 | REL-012、REL-013 | AC15、AC16 | done；未知耗时/费用不补造 |
| T8 | 第三批 | T4、T6 | REL-010、REL-011 | AC11、AC12、AC13、AC14 | done；候选失效明确降级 |
| T9 | 联合验收 | T1–T8 | REL-001–013 | AC17、AC18 及全部回归 | 隔离验证完成；AC18 not_run |

第一批先合入可验证的路由/预算/故障修复。T7 观测随第一批补齐，双端联合验收在 T8 后完成。T6 可先做输出版本和无副作用修复，只有 T8 提供可靠候选后，才可宣称“开发产物可保留并恢复提交”。

## 3. 具体任务

### T0：差异审计与可复核基线

责任：后端与质量。allowedPaths：本四件套、对应模块 `*.spec.ts`、`tests/e2e/` 的隔离样本；仅测试准备阶段不改生产行为。

- [x] 记录 HEAD、相关脏工作树范围、正在运行构建与当前源码是否一致；记录已有 stop/guard/恢复覆盖，避免重复实现。
- [x] 依据 Spec B01–B05 建立脱敏定向夹具（业务版本、事件、调用阶段、错误）；历史耗时保留在 Spec，不重放真实会话、不保存凭据或私人源码。
- [x] 建立心跳导致 stale、重建标记覆盖、超时后重复接单的失败用例。
- [x] 核对 shared、关系存储、file 模式和旧版本记录，设计字段映射；当前无迁移脚本时记录为待开发而非已存在命令。

退出条件：失败用例命中真实缺陷；每条基线标注历史观测/当前代码/推断；真实任务不被重放。

### T1：业务快照、计数与控制命令

责任：会话/上下文。allowedPaths：`apps/server/src/modules/{sessions,context-management,intent-recognition}/`，相关 shared 类型和 persistence 关系映射。

- [x] 引入路由业务指纹，排除心跳/工具日志，并纳入所有影响控制动作合法性的业务变化。
- [x] 原子持久化 snapshotRebuildCount，删除递归无界重建；旧记录迁移不复活终态。
- [x] 租约所有权、业务版本、幂等应用联合校验；重复和迟到分类结果不重复产生动作。
- [x] 精确命令在唯一合法目标时规则执行；歧义、替代 Agent 和未决确认仍尊重现有约束。
- [x] 覆盖 100 条日志追加、新需求到达、二次业务变化、reasonCodes 覆盖、租约过期、服务恢复和消息重复。

退出条件：AC01–03 的确定性测试通过；迁移部分提交 AC14 证据。

### T2：共享操作监督与停止边界

责任：Runtime/执行。allowedPaths：`apps/server/src/common/` 中相关配置/终止文件，`modules/{orchestrator,runtime-invocation,runtimes,local-runtime,execution,queue,persistence,recovery}/`，shared 合同，`packages/local-runtime-cli/src/` 相关进程/传输文件，`.env.example`。

- [x] 建立持久化 LogicalOperation，原子预留 attempts，冻结 policyVersion 和父子截止。
- [x] 系统路由、编排、补上下文、Provider 重试、格式修复接同一预算；短控制操作 120 秒/2 次平台调用。
- [x] 迁入当前长阶段有效配置，避免叠加旧计时器；有限预算被显式禁用或无效配置时给出可诊断策略，不能静默无限执行。
- [x] 明确 transport/model/tool/diagnostic 分类和去重，噪声不续期，长工具有自己的截止。
- [x] 共用上一轮停止回执能力，补齐操作级持久化未知停止、重启核对、迟到回执清理与禁止替代执行。
- [x] 格式预算终止使用准确错误/终止原因，覆盖现有 superseded 语义不匹配风险。
- [x] 验证暂停保存剩余额度、自动重试不重置、人为新尝试有关联审计、后端恢复不自动重放。

退出条件：AC04–06 通过；预算/恢复迁移的 AC14 子集通过。使用假时钟和真实隔离子进程验证，不能只断言发出了 cancel 消息。

### T3：故障分类和候选隔离

责任：Runtime 路由。allowedPaths：`packages/shared/src/` Provider 错误分类和测试，`apps/server/src/modules/{runtimes,runtime-routing,orchestrator}/`，`packages/local-runtime-cli/src/adapters/`。

- [x] 统一 DNS、认证、429、临时 5xx、结构化 424、协议/Schema 不兼容分类。
- [x] 检查 Retry-After、剩余预算、尝试上限；超长退避进入明确等待，不发出超预算调用。
- [x] 故障隔离键细化至连接/模型/协议，支持时效和受控恢复，避免 runtimeType 整体连坐。
- [x] 切换候选前检查原允许列表、执行位置、授权、工具和输出版本；上一调用结束未知则禁止切换。
- [x] 覆盖两条同类 Runtime 不同连接、一条坏模型一条健康模型、没有替代项、迟到成功和认证错误。

退出条件：AC07 通过；错误内容脱敏，未配置真实供应商或修改用户连接。

### T4：程序预检和接单检查点

责任：Agent/任务执行。allowedPaths：`apps/server/src/modules/{agents,tasks,orchestrator,runtime-routing,persistence}/`，相关 shared 类型。

- [x] 实现确定性预检与 decisionSource，不再对明确任务无条件启动工程 CLI 接单。
- [x] 职责配置不明确时保留轻量模型路径，沿用已有 SystemAgentRuntimePolicy，不硬编码新模型。
- [x] 保存预检/接单输入指纹；同范围重试复用，权限/目录/产物/任务/执行人变化重检。
- [x] 保留既有 blocked/rejected、改派确认与 QA 决策语义，不覆盖明确拒绝。
- [x] 对比原超时链路：第一次有效接单一次、执行重试不重新调用接单模型；模拟缺权限不得接受。

退出条件：AC08、09 通过，原质量拒绝/返工回归通过。

### T5：讨论和上下文范围优化

责任：编排/上下文。allowedPaths：`apps/server/src/modules/{orchestrator,context-v2,context-management}/`，shared Prompt/上下文相关实现和测试。

- [x] 收窄需求讨论与架构节点的目标、输出长度策略和证据范围，复用上游引用。
- [x] 原工作流 snapshot、必需节点、顺序和质量闸口保持；缺少必要意见时停止确认推进。
- [x] 独立只读咨询支持有界调度、稳定合并、冲突可见；默认并发 1，不按角色数无限并发。
- [x] 记录初始上下文、读取量和累计用量，防止仅比较初始 Prompt 得出错误节省结论。

退出条件：AC10 通过；真实速度收益留待 AC18。

### T6：最小提交合同与格式修复

责任：Shared/Runtime。allowedPaths：`packages/shared/src/runtime-contracts/`、关联合同测试，`apps/server/src/modules/{runtimes,runtime-routing,orchestrator,artifacts,persistence}/`，`packages/local-runtime-cli/src/adapters/`。

- [x] 以 kind/version 注册最小提交合同，冻结运行版本并协商 Runtime 能力；保留旧存量严格解析。
- [x] 领域结果由系统候选与验证证据组装，不接受模型伪造的文件身份、测试结果和权限。
- [x] 独立无写权限的格式修复路径，共享一次纠正及父预算，不重复开发/测试副作用。
- [x] 覆盖缺必填、错误引用、额外字段、版本不支持、伪造测试通过、有效业务结论缺失。
- [x] 与 T8 联合验证解析失败前已完成产物的可靠保存，不能仅依赖临时目录仍存在。

退出条件：合同/修复定向测试通过；AC11、14 最终在 T8 联合签收。

### T7：阶段观测与双端显示

责任：后端事件/双端。allowedPaths：`apps/server/src/modules/{events,runtimes,ops}/`、相关指标文件，shared 事件/诊断类型，`apps/web/src/{utils/taskActivity.ts,stores,components/UserInputBox.vue,components/SessionWorkspace.vue}`，`apps/desktop/renderer/components/SessionWorkspace.vue`，对应测试。

- [x] 贯穿 operationId/invocationId、policyVersion、阶段时间、重试原因、stopState 和具体模型来源。
- [x] 对无法观测的上游时间/模型/费用标记未知；避免把 CLI 累计 token 当作可计费 token 或初始输入。
- [x] 共享阶段映射，两端按事实显示；保留运行三点、回底、停止/继续、草稿、阅读位置和跨端状态同步。
- [x] 隔离接口样本模拟运行、重试、上游故障、停止未确认、恢复，验证两端相同语义和独立布局。

退出条件：AC15、16 通过；运行阶段指标从第一批即可用于后续测量。

### T8：候选保存与节点内恢复

责任：工作流/本地执行/持久化。allowedPaths：`apps/server/src/modules/{workflows,recovery,persistence,workspaces,worktree-execution,orchestrator,artifacts}/`，`packages/local-runtime-cli/src/` 相关候选与执行文件，shared 恢复/证据类型和迁移测试。

- [x] 扩展现有 NodeRun/attempt 检查点，关联候选 hash 和 writebackId；版本与真实测试证据沿用候选/调用/产物记录，不补造验证通过状态。
- [x] 在进程结束后捕获一致候选，失败路径也可保留合规候选；设置大小、保留期和引用校验。
- [x] 接入提交修复，以及既有质量返工/复测、下游重试和写回冲突恢复；自动提交修复限安全 Claude 路径，缺少能力/额度时保留候选停车。原生续接仅沿用受支持路径，不保证恢复 CLI 思考过程。
- [x] 使用既有幂等 effect 和 FIFO 写回，防止结果重复投递/进程重启造成重复写入。
- [x] 迁移旧记录；候选缺失、过期、跨会话、版本变化、权限撤销均降级明确重试或等待。
- [x] 清理仅限本次创建的 Runtime staging；候选是有界持久化 ChangeSet，不新增候选目录清理器，过期引用拒绝恢复，测试不删除真实用户文件。

退出条件：AC11–14 联合通过；恢复、取消、质量返工和写回冲突回归通过。

### T9：完整链路与效果验证

责任：质量。allowedPaths：相关测试、隔离采样夹具、本四件套和实际交付涉及的合同文档。

- [x] 隔离完整流程覆盖需求→架构→开发→质量不通过→开发返工→复测→交付。
- [x] 另测普通 QA agent 与显式质量闸口语义，不能把普通 agent 自动当 robot_approval。
- [x] 故障矩阵覆盖持续日志、两次业务变化、DNS/502、Schema 错误、长工具、停止无回执、断线、重启、重复写回。
- [x] 跑相关定向测试、类型检查、Harness、必要双端构建和 E2E，记录提交与差异指纹。
- [ ] 在获得范围与费用授权后，执行隔离真实模型对照样本；记录相同模型/工作流/任务、CLI 版本、人工等待、失败分母与预算。
- [x] 更新 Checklist，分别报告实现、隔离验证、真实模型验证；旧记录未复验不能复用 pass。

退出条件：AC17 通过；AC18 只有实际采样完成才能通过。真实样本未获授权或不足时可以交付已验证代码，但整体真实效果必须保持待验证。

## 4. 验证命令与执行记录

按修改范围先定向运行，不为每项小改反复跑全仓；具体新增测试名在实施时记录。

```powershell
npm run test -w @agent-cluster/shared
npm run test -w @agent-cluster/server
npm run test -w @project/web
npm run typecheck
npm run test:harness
npm run test:e2e:cancel
npm run test:e2e:recovery
npm run test:e2e:rework-loop
npm run test:e2e:client-presentation
npm run build
npm run desktop:build
```

会重建 shared/server 或清理测试服务的 E2E 应顺序执行；使用隔离端口、临时数据与模型桩，检查 fixture 不会落到真实模型。真实 Runtime 测试采用仓库现有采样入口和费用规程，不由本命令列表授权。

每项完成记录：日期、HEAD/差异指纹、修改文件、失败用例、验证命令与退出码、相关 AC、剩余限制。执行结果见 Checklist 第 8 节；真实服务没有重启，也没有将历史样本当作修复后的模型效果。

## 5. 实施记录（2026-09-14）

基线 HEAD：`6cdbefb91ca863d4985b495d38d0aa784b57695f`，工作树有既有未提交修改，本轮未提交。主要新增实现：`logical-operation-store.ts`、`task-acceptance-preflight.ts`、`bounded-consultation.ts`、shared `runtime-activity.ts` / `provider-failure.ts` / `minimal-submission.ts`、local `execution-candidate.ts`。同时接入现有 Runtime、上下文路由、工作流、PostgreSQL 映射、CLI 传输和双端共享状态工具。

定向测试新增真实缺陷覆盖：100 条心跳、业务快照失效、重建计数覆盖、过期租约、并发预留、暂停计时、断线回执、长工具截止、提交后保留候选、安全修复副作用检查、错误引用/伪造验证结果、QA 返工不重跑上游。最终验收和运行限制详见 Checklist，不能从勾选推导生产成功率。
