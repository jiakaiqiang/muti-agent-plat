# M-010 / R10a：源码授权、只读候选与写回门交付报告

日期：2026-10-21。依据：[R10 设计 §2、§3、§6 验收 1–2](../intent-follow-up-r10-design-2026-10-21.md)及监督收件箱 M-010。Git 起点 `5ded5262d39b20a0d4c2dfe3cd8a5457faa1b4c2`；使用本轮开工时的 2,973 文件逐文件快照区分已有 R9 改动与本轮改动。

**R10a 已实现并通过夹具验证：服务端源码授权 → generic_llm 只读候选 → 现有写回门 → 真实文件更新。** 最终串行回归 30 文件、769 项：**768 通过、0 失败、1 跳过**。server typecheck/build、shared build、隔离重启、临时 git 仓库真实写回冒烟通过。没有真实模型调用、提交或推送。

**没有开放生产入口。** 候选服务未注册进生产 module；未接带效果 `enqueue_follow_up` 的提交、队列、Brief、派发或前端。线上默认旧链路及开关保持原样。此结果验证服务端执行边界，不是新一轮意图识别准确率评测，也不代表 R10b、CLI 或 IR05 整体已完成。

## 1. 本轮实现

### 1.1 服务端 source authority

`IntentSourceAuthorityStore.issue()` 仅接受持久化会话 owner 的真实用户消息和匹配的结构化授权确认：`reason=intent_source_authorization`、`status=approved`、精确 `sourceAuthorization`。模型输出、Brief 确认和普通读取许可都不能签发源码授权。本轮只由测试夹具调用，没有新增授权 API。

授权不可变部分包括 actor/sourceEvent/WorkItem、workspace binding、epoch/generation、精确文件清单、根目录 realPath/dev/ino、文件 dev/ino、revision、grant 及版本化禁止策略。新版本和撤销保留历史；旧 Session 快照不能覆盖已保存的授权、候选或认领结果。读取限制数量与大小，读取后复核全部文件与根身份，拒绝链接、别名和身份替换。

每次候选调用重新核验版本、有效 grant、独立 workspace read grant、当前执行 binding、operation/task/lifecycle 状态和 R6 未决 hold。候选模式必须携带匹配 actor/epoch/generation/task/调用槽位的 `agent_task` 输入预算标记及合法输入上限。写回不发模型请求，复核源码授权、版本、根/文件身份及当前执行绑定；不把候选调用的预算检查描述成写回层检查。

### 1.2 只读候选与调用前基线

新增输出合同 `intent_source_candidate / 1.0`，模型只能返回 summary 与 `{path,content}` 更新提议，不能提交 authority、候选 ID、baseHash、grant 或服务端 binding。服务端在模型调用前持久化精确基线，并把该基线加入真实输入预算；返回后按保存的基线生成 ChangeSet、baseHash、读集、候选 ID 和完整调用绑定，不重读文件冒充模型见过的版本。

候选保存与 task 的 `candidate_captured` 检查点在同一事务中完成。同 invocation 同提议幂等返回；不同输出拒绝。invocation 审计深拷贝保存 source binding 和 effectScope。源码 invocation 缺候选记录时明确拒绝，不能降级为 legacy writeback。

能力策略仅放行 **generic_llm + candidate_only**。旧调用缺候选描述仍拒绝 `modify_source`；mock、CLI、其它 Runtime/模式维持原判断。候选执行 `writeMode=none`，工具全集仍为 `read_file/search_code/read_attachment`，暴露时再取授权交集；不派生写文件或命令工具，不使用 mock fallback，不隐式修复无效候选输出。

### 1.3 写回强制点

enqueue 核对持久化候选的完整 ChangeSet，ID 相同但内容被篡改仍拒绝。force、冲突编辑、最终合并后的整批 ChangeSet、每个实际文件写入前均复核授权、文件范围及禁止项。冲突编辑同时检查整批编辑后的总大小，失败不推进确认状态或版本；保存事务内再次核验 live authority。

`beginApply()` 与撤权使用同一持久化 Session 事务互斥。未完成或 outcome=unknown 的 claim 不因时间流逝自动释放；同候选成功写回后不能再次应用。provider 必须为 server_local。

仅允许授权清单中已有的 UTF-8 文件 update，拒绝 create/delete/move、二进制、NUL、非法 Unicode、穿越、大小写/NFC 别名、symlink/junction（包括根祖先）和 hardlink。授权清单最多 32 文件、单文件 256 KiB、总量 1 MiB；模型提议合同另限制为最多 16 个 update。

文件锁内检查合并后的真实内容。源码更新先打开不截断的文件句柄，核对 dev/ino/基线，再授权并通过该句柄写入，写后再核验；已复现的“最终检查后替换 root”不能把写入或回滚重定向到替换 inode。后续文件失败会回滚已写文件；部分 I/O 或无法证明回滚完成时保持 unknown 栅栏。

### 1.4 `no_schema_change` 的实际能力

实现是一个**极窄的充分结构检查**：只支持普通顶层 TS/JS 函数，在函数体最前面插入只引用参数/原始字面量的纯 `if … return`；原语句顺序、签名、imports 和函数体外文本保持一致。允许例如空密码直接返回 false；拒绝新增调用、属性访问、赋值、throw、动态 SQL、DDL、ORM 定义以及其它不支持的语法/修改形态。

它不是通用 SQL/ORM 检查器，也不声称证明任意业务调用图的语义。不支持或分析不完整即阻止自动写回；force 不能豁免禁止项。

## 2. 持久化与验收对应

授权、固定基线、候选和 apply claims 存入 Session JSON 的 `intentSourceAuthorities` / `intentSourceCandidates`；任务检查点仍在原 tasks 集合。复用现有集合事务、Session JSON 及正文引用外置，不新增表或迁移。

关系型路径依据：`relational-state-store.ts` 的完整 sourceRecord 写入/装载及统一 hydrate，`content-reference-codec.ts` 的 files/changes content 外置；新增测试实际调用 codec 与关系型 Session 投影写入/装载，验证授权、基线、候选和 unknown claim 往返保持。**这属于存储投影/codec 单测，本轮没有连接 PostgreSQL，不能写成真实 PostgreSQL 集成通过。** 真实 File 持久化、重载和事务不变式已有测试。未操作主库或 Docker。

| 设计验收 | 覆盖及证据 |
| --- | --- |
| §6.1：仅 writeback 改变真实 hash；三个只读工具；伪造模式/CLI 零执行 | Runtime/策略/解析器边界、真实 File 授权服务加模型桩整合；临时 git 写回冒烟。 |
| §6.2：越界、非法操作、旧授权/撤销/版本竞争；force/冲突/merge 不绕过 | authority/candidate、source write guard、writeback/provider 定向及最终回归；负例检查 hash 或零调用。 |
| §6.2：schema 禁止项合法 handler 可过，未知拒绝 | AST 窄子集的正负例、真实 writeback 正例、合并后再校验与失败回滚。 |
| R6–R9 不变量 | 原预算/恢复/重试/对账、单失败任务、执行/队列/workflow/runtime 与旧写回回归均纳入最终 30 文件。 |

## 3. 验证结果与原始失败记录

所有测试使用夹具或本地模型桩；真实模型调用为 0。日志保留 stdout/stderr、退出码与 UTC 时间戳，没有覆盖失败批次。

| 项目 | 结果与证据 |
| --- | --- |
| 初始有效策略红例 | 输出合同/能力边界/解析器 4 个行为失败；[runtime-red.log](evidence/runtime-red.log)。该批另有一次错误 tsconfig 引起的 Generic 文件加载失败，不计作业务红例。 |
| authority 硬化先红后绿 | 缺候选降级、运行归属/读取授权等 15 个行为红例；[authority-hardening-red.log](evidence/authority-hardening-red.log) → 最终 [45/45](evidence/authority-final-green.log)。 |
| Runtime 硬化先红后绿 | 预算标记与审计绑定红例；[runtime-hardening-red.log](evidence/runtime-hardening-red.log) → 十文件 [196/196](evidence/runtime-hardening-regression.log)。 |
| 聚合冲突与 root 替换 | 两项分别先失败：[conflict-aggregate-red.log](evidence/conflict-aggregate-red.log)、[pinned-write-red.log](evidence/pinned-write-red.log)；修正后写回/provider 六文件 [38/38](evidence/workspace-final.log)。 |
| 最终串行回归 | **30 文件，769 项，768 通过、0 失败、1 跳过，exit=0**；[spec-final.log](evidence/spec-final.log)。 |
| server typecheck | **exit=0**；[typecheck-final.log](evidence/typecheck-final.log)。 |
| shared / server build | **均 exit=0**；[shared-build-final.log](evidence/shared-build-final.log)、[build-final.log](evidence/build-final.log)。 |
| 隔离 `npm run dev:restart-server` | **exit=0**；PID 95984→15348、health 正常、runtimeBuildStale=false；[smoke.json](evidence/smoke.json)、[重启日志](evidence/dev-restart-final.log)、[运行日志](evidence/smoke-run.log)。 |
| 临时 git 真实写回 | **通过**；[real-writeback-smoke.json](evidence/real-writeback-smoke.json)、[最终日志](evidence/real-writeback-smoke-final.log)。 |
| 哈希与范围核验 | **通过**；[verification.json](evidence/verification.json)、[capture-final.log](evidence/capture-final.log)。 |

最终唯一跳过项：Windows 创建文件 symlink 返回 EPERM。实际 junction 和根祖先 junction 负例已通过，不能把跳过项写成已验证。`generic-llm-tool-loop-budget.spec.ts` 的既有用例在本次最终回归全部通过。

其它中间失败完整保留：初始 authority/writeback/guard 缺模块的加载失败；首轮 typecheck 的空值窄化与字面量类型错误；第一次 R6–R9 整合中的未完成审计接线和 legacy 排队时序退步。后者通过移除同步 `bindingForCandidate()` 前多余的 await 修复，旧代际排队测试最终通过。`runtime-hardening-green.log` 为写错 spec 路径的零测试启动记录，不当作通过证据。初始 capture 对“仅 shared 构建包含的 spec”误要求 server dist 副本，修正产物映射后成功，原日志保留。

最终 spec 命令为 `node node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json --test --test-concurrency=1 --test-force-exit <下列文件>`；server 路径相对 `apps/server/src/modules/`，均为 `.spec.ts`：

```text
message-routing/intent-source-authority
message-routing/intent-source-candidate
message-routing/intent-reconciliation.service
message-routing/intent-plan-commit.service
message-routing/intent-resume-guard
message-routing/intent-retry-guard
message-routing/intent-message-pipeline.service
runtime-routing/invocation-resolver.service
runtimes/generic-llm-source-candidate
runtimes/generic-llm-runtime.service
runtimes/runtime.service
runtimes/generic-llm-input-budget
runtimes/input-budget-store
runtimes/input-budget-tool-rerun
runtimes/generic-llm-tool-loop-budget
orchestrator/intent-retry-task
orchestrator/orchestrator.service
sessions/sessions.service
workflows/workflow-runtime.service
execution/execution.service
queue/execution.worker
workspaces/intent-source-write-guard
workspaces/workspace-source-apply
workspaces/workspace-source-writeback
workspaces/workspace-writeback-intent
workspaces/workspace-writeback.service
workspaces/workspace-apply-change-set
workspaces/workspace-apply-change-set-concurrency
workspaces/server-local-workspace-provider
```

第 30 文件为 `packages/shared/src/intent-source-runtime.spec.ts`。构建命令：`npm run typecheck -w @agent-cluster/server`、`npm run build -w @agent-cluster/shared`、`npm run build -w @agent-cluster/server`。冒烟脚本为 `.cache/supervisor/r10a-{smoke.mjs,writeback-smoke.ts}`，后者通过同一 server tsconfig 的 tsx 启动。

### 临时目录真实写回事实

在系统临时目录创建小 git 仓库，无 commit。先准备调用前基线，越界 `src/not-authorized.ts` 提议因 `INTENT_SOURCE_FILE_OUTSIDE_MANIFEST` 被拒；随后同一准备槽位生成合法候选并实际 writeback。临时文件在 finally 中清理，不操作本仓库源码。

| 时点 | SHA-256 |
| --- | --- |
| 初始 / prepare / 越界拒绝 / capture | `61b2ebaa761646f5a64780bc9c1e15d193b0bf4e5144b23ca01c78a9eb0c5a4d` |
| writeback applied 后 | `71461ba39e80e0b3c137be34c8251c489b06c257c4f54ecc88ce07b76e19b0f8` |

隔离重启使用随机 localhost 端口和独立临时 File 状态，只在子进程覆盖模型连接为不可连接本地地址并启用本地 mock；`.env` 未变。状态中新增会话和 invocation 均为 0；冒烟进程树已停止。

## 4. 实际改动与设计清单之外的文件

本轮相对开工快照共 **34 个源码/测试文件**：server 23、shared 11；完整逐文件路径、前后哈希见 verification.json。已有 R9a/R9b 未提交文件不计入本轮。

| 文件组 | 本轮改动 |
| --- | --- |
| shared 合同/策略/输出 | `contracts.ts`、`index.ts`、`intent-runtime-policy.ts`；新增 `intent-source-authority-contracts.ts`、`intent-source-contracts.ts`、`intent-source-runtime.spec.ts`；runtime-contracts 的 contract-types/index/output-contracts/structured-output-instructions 及新增 intent-source-candidate。 |
| source authority/candidate | 新增 authority 及 spec、candidate service 及 spec、`intent-source.test-support.ts`；execution guard/test-authority 增加 live source grant。 |
| 持久化 | `intent-record-invariants.ts` 接入新增 `intent-source-state-invariants.ts`，保护完整授权/候选/claim 与旧快照。 |
| Runtime | invocation resolver 及 spec、generic_llm 及新增 source candidate spec。 |
| 写回 | writeback service、apply-change-set、新 guard 及 spec、source apply/writeback spec。 |

设计 §6 未单独点名的实际文件及原因：

- `runtimes/runtime.service.ts` / `.spec.ts`：持久化并深拷贝调用的 sourceCandidateBinding/effectScope，使后续写回能识别源码 invocation，缺候选不能降级；不扩 Runtime 能力或派发入口。
- `workspaces/workspace-provider.ts`、`server-local-workspace-provider.ts`：增加必须携带 guard 的 server_local 应用方法，把最终集合校验传进文件锁与实际落盘；旧 apply 方法保留原路径。
- `intent-source.test-support.ts`、两个 `workspace-source-*.spec.ts`：隔离的可信绑定夹具及真实文件/竞争/I/O 回归，属于验收辅助代码。
- `.cache/supervisor/r10a-*`：隔离重启、临时 git 写回及哈希采集脚本；报告/evidence 为交付证据。

未修改提交层、compiler、execution-scope-resolver、semantic-intent-router、orchestrator、sessions.module、默认配置或 `.env`。web/desktop 相对本轮快照的 **241 个源码文件逐字节不变**，所以本轮未重复跑双端 vitest/vue-tsc/build。未新增数据库迁移。

## 5. 源码与构建哈希

逐文件 SHA-256 包括 34 份源码、33 份 server tsc JS 输出、11 份 shared dist JS 输出，见 [verification.json](evidence/verification.json)。shared 独立 spec 不在 server 的传递编译集合中，已有对应 shared dist，不虚构 server 副本。以下聚合按路径排序后对 `[{path,sha256},…]` 的 JSON 做 SHA-256：

| 集合 | SHA-256 |
| --- | --- |
| 本轮源码/测试 | `59879d10f7e6a062da34e4ff7e8f98d43c5524dcdfc98cd7ac0caa9738c27354` |
| 对应 server dist | `8d8b0f9da131b4b2eab0f14b46ea49f85cf1901256c273ec661148d2870e002b` |
| 对应 shared dist | `e144d52cd6687f90ed577f6bc4d4b68b30b85de94de63fcc239e658b3b81b807` |

compiler、scope resolver、semantic router、提交层、orchestrator、sessions.module 和 `.env` 共 7 个重点保护文件均与开工快照一致；全部哈希在 verification.json。`intent-runtime-policy.ts` 按 M-010 明确授权修改，仅 candidate-only 分支。

## 6. 已知限制与停止点

- 本轮使用夹具建立授权和调用绑定，**正常生产追加需求仍未接通**；R10b 需另行授权。没有改意图识别提示词、评测题目或默认意图路由开关，没有新增正式模型成绩。
- schema 禁止策略只支持上文极窄插入语法；普通类方法、框架 handler 的复杂改动也可能拒绝，这是失败关闭的边界。
- 部分 I/O、崩溃或无法证明回滚完成会保留 unknown/applying 栅栏；进入固定句柄步骤后，即使实际写入前失败，也可能保守记为 unknown。它会阻止后续 apply 和撤权。本轮没有新增解除未知源码 claim 的自动恢复或人工操作入口，不能把 R9 三动作说成已覆盖它。
- 固定句柄防止已测试的路径/根替换重定向，并检查外部内容变化；没有声称提供操作系统级沙箱或阻止任意外部进程直接修改已授权 inode。
- 本轮未做真实 PostgreSQL source 集成、真实模型或双端界面验收；文件 symlink 场景有一项宿主权限跳过。关系型 codec/projection 测试、junction 实测与上述限制分别记录。

M-010 交付完成后停止，等待监督方复核；不启动 R10b，不提交、不推送。
