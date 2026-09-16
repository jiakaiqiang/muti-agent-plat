---
artifact: verification_summary
stage: verification
producedBy: test
schemaVersion: "0.1"
status: ready
result: partial
deliveryId: agent-execution-reliability-v1
createdAt: 2026-09-14
intentContractRef: agent-execution-reliability-spec-v1
implementationSummaryRef: agent-execution-reliability-tasks-v1
---

# Checklist：Agent 执行可靠性与调用效率修复

[Spec](../product/agent-execution-reliability-spec-v1.md) · [Plan](../design/agent-execution-reliability-plan-v1.md) · [Tasks](../implementation/agent-execution-reliability-tasks-v1.md)

## 1. 状态与证据规则

2026-09-14 已完成代码实现与本次隔离验证。AC01–17 的证据列在下方，能力限制沿用 Spec §7 / Plan §9；AC18 未执行，因此整体 result=partial，不能宣称真实模型已提速或任务生产完成率已提升。历史会话只用于问题基线。

- pass 必须附测试名、命令退出码、代码指纹和日志/事件证据。
- fail 表示已执行且不符合；not_run 表示尚未执行；blocked 记录具体外部条件，不能以缺证据冒充 pass。
- 文档验证与业务验收分开。文档链接和编号完整不能证明 Runtime 正常。
- 隔离模型桩不证明真实供应商延迟、完成率或费用；真实模型样本也不能代替幂等和异常测试。

## 2. 文档质量门禁

- [x] D01 四份文档 deliveryId 一致、互相链接有效。
- [x] D02 REL-001–013、T0–T9、AC01–18 全覆盖，无孤立需求或虚假完成项。
- [x] D03 明确历史观测、计划行为、初始配置、真实待验收益和非目标。
- [x] D04 保留所选工作流、质量语义、Context v2、目录隔离、双端独立布局。
- [x] D05 操作预算、停止确认、输出版本、检查点恢复、迁移/回滚和风险可实施。
- [x] D06 文档编制轮与实施轮记录分开；当前实现、隔离验证和真实模型待验状态明确。

## 3. AC 追踪与用例

| AC | 规格 | 任务 | 必须执行的验证 | 状态 | 证据 |
| --- | --- | --- | --- | --- | --- |
| AC01 | REL-001 | T1 | 100 条噪声不失效，业务变更拒绝旧结果 | pass | context-management.service.spec：routing snapshots ignore progress noise；任务/状态变化断言 |
| AC02 | REL-002 | T1、T2 | 重建一次、原因覆盖和服务重建不重置；租约和动作幂等 | pass | context-management 的 rebuild allowance / late classifier / concurrent lease / apply 用例 |
| AC03 | REL-002 | T1 | 合法精确命令零模型，歧义不执行 | pass | deterministic-command-guard、command-application、semantic-intent-router 回归 |
| AC04 | REL-003 | T2 | 两入口共用截止/尝试预算；暂停保存余额，格式修复不增加额度 | pass | logical-operation-store、runtime-invocation、runtime.service；file 与 PostgreSQL 并发/恢复测试；结果等待额度落盘、持久化失败取消、缓冲事件去重用例 |
| AC05 | REL-004 | T2 | 噪声不续期，长工具独立截止 | pass | shared runtime-activity；local-runtime-activity：long tools own a fixed deadline |
| AC06 | REL-004 | T2、T3 | 结束回执、未知停止阻止替代、迟到结果不写回 | pass | runtime-process-stop、local-runtime-connection、logical-operation-store；RuntimeService 实际 15 秒停止宽限/阻止替代/迟到结束用例；cancel/recovery E2E。无回执的工程进程仍停车 |
| AC07 | REL-005 | T3 | 故障分类、连接隔离、Retry-After 和允许列表 | pass | shared provider-failure；orchestrator Provider 重试/回退及 Runtime 路由回归 |
| AC08 | REL-006 | T4 | 明确任务规则接单，权限重检，不自动批准 QA | pass | task-acceptance-preflight；orchestrator task retries reuse acceptance；普通 QA/robot 节点回归 |
| AC09 | REL-007 | T4 | 重试复用，范围/权限/执行人/证据变更失效 | pass | acceptance fingerprint；orchestrator 缓存复用后撤销权限/改变任务范围定向测试 |
| AC10 | REL-008 | T5 | 冻结工作流、咨询有界且必要意见不可跳过 | pass | bounded-consultation（顺序、上限、异常收敛）；orchestrator 讨论失败回归 |
| AC11 | REL-009 | T6、T8 | 保存候选后只修提交，拒绝伪造证据/额外修改 | pass | local runtime.spec：failed submission preserves a candidate（含 safe-mode）；shared minimal-submission；orchestrator：修复耗尽/不支持不重放开发。自动修复限安全 Claude 路径 |
| AC12 | REL-010 | T8 | 提交/返工/下游/写回恢复各自步骤 | pass | 上述候选用例；workflow-runtime 完整返工用例；workspace-writeback 幂等/冲突/恢复回归 |
| AC13 | REL-010 | T8 | 候选范围、权限、hash、基线和有效期安全边界 | pass | runtime.spec：跨 session/workItem/task/workspace、过期/非法时间、版本/hash/权限/基线变化在启动前拒绝；显式关联原任务可修复；副作用拒绝；原始目录未写入 |
| AC14 | REL-011 | T1、T2、T6、T8 | file/Postgres 持久化、输出版本、重启不自动重放 | pass | 独立 PostgreSQL 4 项全部通过；file 操作存储；输出 v1/v2 严格验证；recovery E2E。未执行真实部署回滚 |
| AC15 | REL-012 | T7 | 双端共同状态与独立布局/交互 | pass | Web 全量、taskActivity 6 项、WorkspaceSync/ChatScrollArea；client-presentation E2E；桌面 CSP 白屏回归见 §9，修复后真实 Electron desktop-render 通过 |
| AC16 | REL-013 | T7 | 调用可追溯、模型/耗时/费用未知不补造 | pass | Runtime 调用日志与 operationTelemetry 回归；firstUseful 延迟、工具区间、未分类耗时，计费明确 null |
| AC17 | REL-001–013 | T9 | 需求→架构→开发→QA返工→复测→交付边界 | pass | workflow-runtime：reliability flow；cancel / recovery / rework-loop 隔离 E2E。执行器桩不证明真实开发质量 |
| AC18 | REL-013 | T9 | 授权隔离真实模型对照样本；任务/模型/流程一致，耗时、成功分母、失败原因和费用条件齐全 | not_run | 待填 |

## 4. 集成故障矩阵

| 注入点 | 故障 | 应观察到的闭环 |
| --- | --- | --- |
| 识别结果返回前 | 持续心跳与工具日志 | 分类成功后动作只应用一次 |
| 识别结果返回前 | 连续两次用户业务变更 | 首次重建，后续明确等待，自动调用有界 |
| Provider 首次连接 | DNS/502/认证不通过 | 分类准确；可恢复才有界重试；无候选则停车 |
| 模型没有有效输出 | 重复状态噪声 | 有效进展超时，请求停止并核对回执 |
| 长工具执行 | 有进展但总时长较长 | 工具专属截止生效，模型空闲不误杀 |
| 文件已改、提交前 | 错误 JSON/缺字段 | 保存可靠候选，禁副作用修复提交 |
| 质量阶段 | revise 或普通 agent blocked | 按真实节点合同返工/停车，不隐式改节点类型 |
| 写回 | 同文件有用户并发修改 | 既有合并/冲突流程，不能覆盖用户新内容 |
| 停止/重启 | 无回执、迟到成功、重复结果 | 未知停止不重放；幂等处理；明确恢复入口 |

## 5. 效果测量表

| 指标 | 已知历史基线 | 新版本验收方式 | 当前结果 |
| --- | --- | --- | --- |
| 同消息系统识别次数 | 样本已观测 6 次 | 无业务变化一次；全部自动平台尝试≤2，规则控制0次 | 未测 |
| 明确任务完整 CLI 接单数 | 样本首次931秒、重试又接单 | 接单完整CLI调用0次，程序预检耗时单列 | 未测 |
| Schema失败后的开发重放 | 既有机制可能整调用失败 | 可靠候选存在时开发副作用新增0次 | 未测 |
| 控制模型操作活动时间 | 重建循环累计多分钟 | 初始120秒预算；停止回执宽限单列，超时不是成功 | 未测 |
| 需求到契约时间 | 样本约83分钟，不含后续用户等待 | 同配置样本比较，报告中位数/尾延迟与失败分母 | 未测 |
| 契约确认到交付 | 首个架构节点约36分钟失败 | 按工作流节点、人工等待、返工轮次拆分 | 未测 |
| token/成本 | 六次路由上报101586 token | 记录缓存/未知用量，不直接当计费token或费用 | 未测 |
| 完整任务成功率 | 无同版本受控基线 | 分母包含失败；标样本数与配置，不用历史混版本推断提升 | 未测 |

对于确定性 AC，用隔离样本断言次数/状态/副作用即可。对于生产超时建议与成功率，真实样本、稳定配置及充分样本量是必要证据；少量成功样本只能证明可运行，不能证明稳定性百分比。

## 6. 实施验收记录模板

```text
日期 / HEAD / 相关 diff 指纹：
批次 / 任务 / AC：
环境、Runtime、模型、输出合同与策略版本：
命令 / 测试名 / 正常退出码：
隔离目录、端口、夹具类型：
结果 / 日志、事件、截图或报告位置：
是否调用真实模型、授权范围、实际用量和费用缺失项：
未通过项 / 恢复位置 / 剩余风险：
```

## 7. 本轮文档交付记录

以下为原文档编制轮记录；不代表当前实现轮状态。

2026-09-14：依据当前会话已完成的架构诊断和修复讨论，以及项目地图、Harness 协议、既有质量返工四件套与 Runtime 合同生成本四件套。未修改业务代码、真实配置、任务数据或运行服务，未生成安装包或调用真实模型。

文档检查：只读 Node 校验正常退出 0，核对 4 份文件、18 个本地链接、13 条规格、10 个任务、18 条验收标准，以及 deliveryId、代码围栏和行尾空白。初次检查发现任务矩阵中的部分编号使用简写，已改为完整编号后复验通过。`npm run test:harness` 正常退出 0；此命令验证仓库工程规程，不代表新业务行为通过。D03–D05 经文档内容复核，具体实现仍须按 T0 核对。

业务测试和构建未运行，因为本轮仅新增文档；AC01–18 保持 not_run。后续实施不能沿用上一轮停止控件测试数字作为本方案的验收结果。

## 8. 实施验证记录（2026-09-14）

HEAD：`6cdbefb91ca863d4985b495d38d0aa784b57695f`＋当前未提交工作树。所有以下通过记录均来自本次实施调用，退出码 0。

| 命令 / 范围 | 本次结果 |
| --- | --- |
| `npm run test -w @agent-cluster/server` | 最终全量 1277 通过，5 跳过；附属开发脚本 7 通过。跳过含 4 项 PostgreSQL 用例及 Windows symlink 权限限制；PostgreSQL 已另测 |
| 接单集成与业务指纹定向回归 | 75 通过；新接单复用/权限撤销已纳入上行最终全量 |
| RuntimeService / LogicalOperationStore 最终定向回归 | 29 通过，含真实 15 秒停止宽限、迟到结束保留暂停、无回执禁止替代、修复预算持久化失败停车、已知记账与事件迭代器分离 |
| `npm run test -w @agent-cluster/shared` | 92 通过 |
| `npm run test -w @agent-cluster/local-runtime-cli` | 83 通过；新增 safe-mode 及候选安全边界断言后 runtime.spec 定向 21 通过 |
| `npm run test -w @project/web` | 全量 272 通过；新增停止回执/重试映射后 taskActivity 6 项通过 |
| `npm run typecheck` | 全 workspace 通过 |
| `npm run test:harness` | 最终通过；验证规程及合同一致性，不能替代业务测试 |
| `npm run build` | shared/local CLI/server/Web/desktop 全部通过；Vite 提示既有较大 chunk |
| `npm run test:e2e:cancel` | 停止群聊无迟到 Brief、暂停无继续进度，恢复后仅一个最终交付 |
| `npm run test:e2e:recovery` | 崩溃任务/讨论保持停车，用户继续后恢复，不自动启动 |
| `npm run test:e2e:rework-loop` | 质量持续要求返工时遵守上限，限额后等待用户，不提前交付 |
| `npm run test:e2e:client-presentation` | Web 与桌面布局、记录、流程、只读路由通过；隔离截图位于 `output/playwright/client-separation/` |
| 独立 PostgreSQL integration spec | `postgres:16-alpine` 临时容器，随机 loopback 端口及 tmpfs；4 通过，涵盖原子操作预算/重启、幂等迁移、关系投影和旧数据导入。容器已停止并自动清理，无用户数据库写入 |
| 文档/差异检查 | 四件套 18 个本地链接、13 条规格、10 个任务、18 条 AC、deliveryId/围栏/空白通过；`git diff --check` 退出 0 |

本轮没有重启既有服务、改真实 `.env`、重放用户任务、提交代码或调用真实模型。CLI `--help` 仅用于确认安全修复参数，未启动模型。候选安全验证使用临时目录与适配器桩；任务链路与双端验证使用隔离执行器/API 桩，不能冒充真实模型提速证据。AC18 仍为 not_run。

仍需部署后的真实验收：同配置模型样本和费用测量、不同 CLI 版本的安全参数支持。无可信停止回执的旧工程进程不自动解除屏障；不能将这一停车边界解释为已恢复进程内思考。

### 8.1 上一实施批次代码指纹（白屏修复前）

以下 24 个核心文件在上一实施批次结束时的工作树内容（包含既有修改，不表示全部差异均来自本轮）按路径字典序组合：逐个追加 UTF-8 `path + NUL`、文件原始字节、`NUL`，计算 SHA-256。它是历史源码快照指纹，不是提交 ID，也不覆盖整个工作树；§9 后续修复已改变其中的 minimal-submission.ts。

`847daed9a7299dd0ab83579325c6eb98074583ece83b912bb9624bba74b43807`

```text
apps/server/src/modules/context-management/context-management.service.ts
apps/server/src/modules/intent-recognition/semantic-intent-router.service.ts
apps/server/src/modules/local-runtime/local-runtime-connection.service.ts
apps/server/src/modules/orchestrator/bounded-consultation.ts
apps/server/src/modules/orchestrator/orchestrator.service.ts
apps/server/src/modules/orchestrator/task-acceptance-preflight.ts
apps/server/src/modules/persistence/relational/postgres-migration-runner.ts
apps/server/src/modules/persistence/relational/relational-state-store.ts
apps/server/src/modules/runtime-invocation/runtime-invocation.service.ts
apps/server/src/modules/runtime-routing/invocation-resolver.service.ts
apps/server/src/modules/runtimes/logical-operation-store.ts
apps/server/src/modules/runtimes/runtime.service.ts
apps/server/src/modules/sessions/sessions.service.ts
apps/server/src/modules/workflows/workflow-runtime.service.ts
apps/web/src/utils/taskActivity.ts
packages/local-runtime-cli/src/adapters/claude-code-adapter.ts
packages/local-runtime-cli/src/execution-candidate.ts
packages/local-runtime-cli/src/runtime.ts
packages/local-runtime-cli/src/transport.ts
packages/shared/src/contracts.ts
packages/shared/src/local-runtime-contracts.ts
packages/shared/src/provider-failure.ts
packages/shared/src/runtime-activity.ts
packages/shared/src/runtime-contracts/minimal-submission.ts
```

## 9. 桌面 CSP 白屏回归修复（2026-09-14）

用户实际启动发现白屏。独立 Electron 临时配置复现：`EvalError`，CSP `script-src 'self'` 拒绝 Ajv 的 `new Function`；Vue 挂载前中断，`#app` 子元素为 0。原因是 minimal-submission.ts 在导入时直接 compile。此前 client-presentation 在 HTTP 静态服务中验证，未加载 Electron CSP；启动器仅确认窗口可见，均不足以证明真实桌面已渲染。因此此前 AC15 的桌面证据存在缺口，本节补充实际回归。

修复将 Ajv 校验器移至首次 validate 时编译并缓存。服务端启动 preflight 继续验证严格合同；桌面没有放宽 CSP、sandbox 或 contextIsolation。新增 `tests/e2e/desktop-render-smoke.mjs` 和 `npm run test:e2e:desktop-render`，在实际 Electron 自定义协议下检查连接页、工作台、刷新及无脚本异常，仅使用隔离只读 API。

验证结果：

- 修复前新测试退出 1，捕获同一 CSP EvalError，页面挂载超时。
- 修复后 `npm run desktop:build` 退出 0；真实 Electron 渲染回归退出 0，截图在 `output/playwright/desktop-render/`。
- `npm run test -w @agent-cluster/shared`：92 通过；`npm run typecheck -w @agent-cluster/shared`、`git diff --check` 均退出 0。桌面构建同时检查 renderer 类型。
- 使用应用 Ctrl+Q 安全退出旧实例，并重新打开开发 profile；Windows 窗口截图与可访问性树确认左侧任务、中心消息/输入框、右侧 Agent 面板均已渲染。未恢复业务任务、修改授权或重启后端。
- 未重复运行全仓测试；本轮集中验证共享校验合同和真实桌面渲染，不能沿用此前全量数字冒充本轮重跑。

本轮原始文件 SHA-256：minimal-submission.ts 为 `31024dcb2537a2761ffc73324ed193c740c7137fc67d4e01de5d29d6b4b89cc6`，desktop-render-smoke.mjs 为 `c15cf4f64460d515610e06df3a1d712c7f165257f06f5939a42ece23428e00b2`。真实模型效果 AC18 仍未采样；本地 Agent 授权失效与此白屏是独立问题。
