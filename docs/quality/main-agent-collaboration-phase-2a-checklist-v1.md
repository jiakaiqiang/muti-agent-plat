# 阶段 2A：统一消息意图、需求隔离与完整 Token 预算 — Checklist v1

> 日期：2026-09-16（2026-09-17 回填证据）
> 状态：**阶段 2A 已验收通过（2026-09-17）。**T1–T6、跨进程预算竞争、真实 HTTP 路由、真实 Web + Electron SSE、停止/删除/恢复、千条历史上界、L0 信任边界和旧工具结果引用化均已复验。结论仅覆盖当前 mock / generic LLM 适配器；真实付费和多模态 Provider 未接入，明确记为未执行，不外推为生产验证。
> 依赖：阶段 0、1 通过；为 2B、2C、3 提供统一上下文入口。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-2a-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-2a-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-2a-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-2a-checklist-v1.md)

## 1. 验收矩阵

| 验收 ID | 关联任务 | 场景与预期 | 状态/证据 |
| --- | --- | --- | --- |
| P2A-AC1 | P2A-T1、P2A-T6 | 双端重复提交同一消息只产生一个业务路由；含“不要停止”的普通句子不误判为停止命令。 | **已验收**：`npm run test:e2e:phase-2a-routing` 以真实 HTTP 模拟 Web/桌面并发同一幂等键，断言只有一条业务消息、同一 follow-up/routing ID 且恰有一方为重放；既有 deterministic guard 单测确认普通自然语言不误触发停止、精确 continue 不调用模型。 |
| P2A-AC2 | P2A-T1、P2A-T2、P2A-T6 | 构造多意图语料与“这个也加上/按上次方案/继续”案例，检查目标与动作；无绑定的确认不能批准任意待办。 | **已验收**：同一真实 HTTP 路由 E2E 用“继续修复登录，同时新增导出”验证多意图只进入 `CLARIFICATION_REQUIRED`，不会猜测执行；semantic-intent-router golden dataset 与 fail-closed 校验覆盖 @、旧 WorkItem、无绑定确认和 Runtime 失败澄清。 |
| P2A-AC3 | P2A-T1、P2A-T2、P2A-T3、P2A-T6 | 一千条旧消息/一百个历史需求不被整包注入；用户 @ 质量 Agent 时保留明确目标，非成员走选择/加入确认。 | **已验收**：`context-management.service.spec.ts` 注入 1,000 条历史消息和 101 个候选需求，断言快照使用声明上限、旧消息不进入分类输入且序列化载荷小于 40 KB；同组用例断言服务端解析的 @ 与 replyTo 被保留、跨会话 reply 被拒绝。 |
| P2A-AC4 | P2A-T2、P2A-T3、P2A-T6 | A 中的私有需求片段不进入 B；独立需求不继承旧约束；含指令的文件/聊天不能扩大工具权限。 | **已验收**：Context v2 的 WorkItem 切片排除同会话其他需求；`l0-trust-boundary.spec.ts` 断言摘要、文件与聊天内容一旦进入 L0 即以 `L0_TRUST_BOUNDARY_VIOLATION` 失败；预算恢复 E2E 断言拆分后的关联 WorkItem 不继承旧决策或产物。 |
| P2A-AC5 | P2A-T4、P2A-T6 | 长中文、长 schema、图片/工具返回使完整请求超限时，在发送前触发确定的裁剪/容量拒绝；不能只检查 L3。 | **文本适配器已验收；多模态延期**：请求按 system / 工具 / ContextEnvelope / schema / 工具历史归因并逐轮复算；`token-budget` E2E 验证正常用量记录与极小预算发送前拒绝，T6 长输入矩阵覆盖长中文和长 schema。当前 `generic_llm` 只发送字符串消息，图片/多模态 Provider 接入列入后续专项，不作为阶段 6 发布门禁阻断项。 |
| P2A-AC6 | P2A-T5、P2A-T6 | 并发专家不可各自花完整剩余额度；重启/重试不重置累计预算；预算耗尽进入主 Agent 可解释的等待状态。 | **已验收**：一次性 PostgreSQL 与跨进程脚本断言并发只允许一个预留、重放结算幂等且重启读回；`work-item-budget-recovery` E2E 验证额度耗尽进入 `WAIT_USER_DECISION`、仅可拆分或取消、旧 WorkItem 不会被重试。取消后迟到结果由 `runtime.service.spec.ts` 断言只结算一次，不能复活成功状态。 |
| P2A-AC7 | P2A-T3、P2A-T4、P2A-T6 | 最小必要证据仍超容量时不发送残缺请求，不宣称完成；相同补读要求去重，有限重试后给出原因。 | **已验收**：超限在发送前返回可理解的容量阻塞，补读去重沿用既有 `supplemental-context-dedupe`；`generic-llm-tool-loop-budget.spec.ts` 断言旧工具结果转为 `TOOL_RESULT_REFERENCE`，最新工具调用/结果对仍完整保留。 |

## 2. 现有验证入口

以下命令从仓库根目录实际执行（2026-09-17）。

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json --test apps/server/src/modules/context-management/context-management.service.spec.ts apps/server/src/modules/intent-recognition/semantic-intent-router.service.spec.ts apps/server/src/modules/message-routing/message-ingress.service.spec.ts apps/server/src/modules/intent-recognition/deterministic-command-guard.service.spec.ts
node node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json --test apps/server/src/modules/runtimes/generic-llm-tool-loop-budget.spec.ts
npm run test:e2e:token-budget
npm run test:e2e:work-item-budget-recovery
npm run test:e2e:client-presentation
npm run typecheck
npm run test
```

相关既有测试：

- [deterministic-command-guard.service.spec.ts](../../apps/server/src/modules/intent-recognition/deterministic-command-guard.service.spec.ts)
- [command-application.service.spec.ts](../../apps/server/src/modules/message-routing/command-application.service.spec.ts)

**注意**：以 `tsx --test` 批量运行 spec 时必须显式传 `--tsconfig apps/server/tsconfig.json`。省略会因 `experimentalDecorators` 未启用而报 `Parameter decorators only work when experimental decorators are enabled`，把带 NestJS 装饰器的文件整片误判为文件级失败。官方 `run-unit-tests.mjs` 之所以不受影响，是因为它把 `cwd` 设在 `apps/server`。

## 3. 必须补充的测试

- [x] 最终 adapter 请求及每轮工具循环 Token 守卫测试——已补 `runtimes/generic-llm-tool-loop-budget.spec.ts`（3/3，含“超预算轮在发送前被拦截、未被截断”断言）与 `runtimes/generic-llm-token-estimation.spec.ts`（5/5，覆盖分面归因、跨轮累计用量、material 误差、零用量不伪造误差、容量阻塞仍留诊断）。
- [x] 独立 PostgreSQL 预算并发预留/结算测试——`postgres-migration-runner.integration.spec.ts` 新增用例，经 `node scripts/test-session-persistence-postgres.mjs` 在一次性临时库执行；跨实例并发、跨实例读回、结算释放、重放幂等、行级落库均有断言。
- [x] 主 Agent 消息意图标注 fixture 回归——semantic-intent-router 的 golden dataset 用例经同一 `validate` 路径执行。
- [x] WorkItem 预算耗尽恢复 E2E——`npm run test:e2e:work-item-budget-recovery` 覆盖终端阶段耗尽进入等待、无旧 WorkItem 重试、缩小需求创建关联 WorkItem 且不继承旧决策/产物。
- [x] 请求预算 E2E——`npm run test:e2e:token-budget` 覆盖正常请求用量记录与极小预算发送前拦截。

## 4. 跨阶段安全复核

- [x] file/PostgreSQL 行为对等；涉及并发的场景用独立 PostgreSQL 和独立连接/实例验证，不只使用 mock。已用一次性临时库验证：file 后端 store 7/7；PostgreSQL 集成 10/10；跨进程竞争单独脚本通过。**注意**：临时库用完即删，开发库未受影响（只读核对：无 `work_item_budgets` 表、已应用迁移最高为 9）。
- [x] 重复、乱序、重启、取消/删除、迟到结果均不破坏幂等与版本边界。`phase-2a-routing` E2E 覆盖并发幂等；`context-management.service.spec.ts` 覆盖迟到分类器不能覆盖已回收的路由 lease；`recovery`、`cancel`、`session-delete` E2E 分别覆盖重启、停止、软删除/恢复；`runtime.service.spec.ts` 覆盖迟到 Provider 结果只结算一次且不重发成功。
- [x] 未确认范围、高风险动作、未知停止状态均不会被摘要/缓存/模型判断绕过。L0 信任边界拒绝摘要、文件与聊天文本提升为系统规则；未确认停止屏障在迟到进程退出前保持关闭。阶段 2A 未引入缓存/长期召回路径，因此不存在可绕过此边界的 2A 缓存实现；2B 的缓存工作未被提前实现或标记完成。
- [x] 双端保持同一业务状态和各自样式；不依赖刷新才能修复状态。`npm run test:e2e:phase-2a-client-sse` 启动真实 Web、Electron 和服务端，断言两端收到相同事件 ID、Web 断线期间可 HTTP 回补、重连后继续实时同步；`client-presentation` E2E 验证独立构建资源不串样式。
- [x] 无凭据、完整敏感提示或用户私有正文进入测试报告与指标。本次证据只记录命令、用例名与计数。
- [x] 所有文档/合同更新与实际实现一致，回退方案已演练或明确未执行。四份 2A 文档已按实际命令和结果回填；回退**明确未执行**，因为它会主动改变当前验收态且用户要求不影响 2B。该决定不表示已演练，真实 Provider 接入或发布前仍需另行安排回退演练。

**本次复核发现的风险（已闭合）**：`apps/server/src/common/path-safety.ts` 的 `assertWithinRootRealpath` 原先在符号链接 `realpath` 抛 `ENOENT` 时会走“尚未创建”回退分支，退化为纯字面路径比较并**放行**无法解析的路径（悬空符号链接）。该文件最近提交为 `7908b3f`，**不在本次工作区改动范围内**，属既有缺陷；在无法创建符号链接的机器上测试会走 skip 分支而“通过”，因此长期未被发现。

已按“失败关闭”修复：把 `ENOENT` 拆成两种语义——`lstat` 失败（路径确实不存在）才允许向上爬父目录，`lstat` 成功但 `realpath` 抛 `ENOENT`（路径存在却无法解析）一律按越界拒绝；同时删掉 `stat.isSymbolicLink() ? await realpath(probe) : await realpath(probe)` 这处两分支完全相同的死代码。详见第 5 节。

**修复过程中纠正的一次误诊**：本机最初把 3 个用例失败归因于上述缺陷，实际是两层原因叠加。探针实测：本机 `symlink(target, link, 'file')` **返回成功却不创建真正的符号链接**——`lstat().isSymbolicLink()` 为 `false`、`readlink()` 抛 `EINVAL`、`realpath(link)` 返回链接自身路径，即环境把文件符号链接降级成了普通文件（偶发更糟：什么都不创建，`lstat` 抛 `ENOENT`）。此时磁盘上根本不存在越界链接，守卫放行是**正确**行为，用例断言的 `Missing expected rejection` 属测试环境伪影。因此除修守卫外还修了 fixture：不再凭 `symlink()` 的返回值判断，改用 `lstat` 核实，并在文件符号链接不可用时**回退到目录联接（junction）**。junction 在 Windows 上无需管理员权限且是真实重解析点（`isSymbolicLink()` 为 `true`、`realpath` 解析到外部目录），因此这 3 个用例现在在本机是**真实验证通过**而非跳过。详见第 5 节。

## 5. 证据记录

执行日期：2026-09-17。环境：Windows、Node 22.22.2（另用 Node 20.19.6 复跑符号链接用例，结果一致）；当前未提交工作树；未调用真实付费模型。

| 范围 | 命令/入口 | 结果 |
| --- | --- | --- |
| T1/T2 核心 | 第 2 节第 1 条（4 个 spec） | 33 / 33 通过，0 失败 |
| T3 核心 | context-v2 全部 14 个 spec + `orchestrator.service.spec.ts` | 139 / 139 通过，0 失败 |
| T4-3 核心 | 第 2 节第 2 条 | 3 / 3 通过，0 失败 |
| T4-1 核心 | `runtimes/generic-llm-token-estimation.spec.ts`（5 例） | 5 / 5 通过，0 失败 |
| T5-1 核心 | `runtimes/work-item-budget.spec.ts`（9 例） | 9 / 9 通过，0 失败 |
| T5-3 策略 | `runtimes/work-item-budget-policy.spec.ts`（6 例） | 6 / 6 通过，0 失败 |
| T5-2 核心（file） | `runtimes/work-item-budget-store.spec.ts`（7 例） | 7 / 7 通过，0 失败 |
| T5-2 核心（PostgreSQL） | `node scripts/test-session-persistence-postgres.mjs`（一次性临时库） | 10 / 10 通过，0 失败 |
| T5-3 接线 | `runtimes/runtime.service.spec.ts`（31 例，含新增 3 条） | 31 / 31 通过，0 失败 |
| T6-1 意图 fixture | `intent-routing-golden.dataset.spec.ts` + `semantic-intent-router.service.spec.ts` | 7 / 7 通过，0 失败（新增 @ 目标保留与丢弃两类） |
| T6-2 长输入矩阵 | `runtimes/generic-llm-request-guard-matrix.spec.ts`（4 例） | 4 / 4 通过，0 失败 |
| T6-3 跨进程预算竞争 | `npm run test:postgres:work-item-budget`（一次性临时库，两个独立进程） | 通过：恰好一个预留成功、一个被拒，账本一行 700 |
| 预算耗尽终端阶段回归 | `runtime-error.spec.ts`、`orchestrator.service.spec.ts`、`sessions.service.spec.ts`、`execution.service.spec.ts` | 156 / 156 通过，0 失败 |
| 请求预算 E2E | `npm run test:e2e:token-budget` | 通过：正常路径记录非零用量；极小预算在请求前报告 `TOKEN_BUDGET_EXCEEDED` 与结构化估算详情 |
| WorkItem 预算恢复 E2E | `npm run test:e2e:work-item-budget-recovery` | 通过：会话进入 `WAIT_USER_DECISION`，WorkItem 为 `WAITING_USER`，仅可拆分/取消；新 WorkItem 关联旧项且不继承旧决策/产物 |
| 客户端呈现 E2E | `npm run test:e2e:client-presentation` | 通过：Web 与桌面端均展示预算确认卡、工作流与只读路由；独立构建资源不串样式 |
| runtimes + common | 62 个 spec | 465 / 465 通过，0 失败 |
| workspace：local-runtime-cli | `tsx --test-force-exit` | 83 / 83 通过，0 失败 |
| workspace：shared | `tsx --test-force-exit` | 107 / 107 通过，0 失败 |
| workspace：web | `vitest run` | 288 / 288 通过（60 文件），0 失败 |
| workspace：dev-supervisor | `node --test-force-exit` | 37 / 37 通过，0 失败 |
| workspace：desktop | `tsx --test-force-exit` | 13 / 13 通过，0 失败 |
| 阶段 2A 路由 E2E | `npm run test:e2e:phase-2a-routing` | 通过：Web/桌面并发同幂等键只生成一条消息/路由，多意图进入澄清 |
| 阶段 2A 双端 SSE E2E | `npm run test:e2e:phase-2a-client-sse` | 通过：Web + Electron 同事件 ID、断线 HTTP 回补、重连继续同步 |
| 停止/删除/恢复 E2E | `npm run test:e2e:cancel`、`npm run test:e2e:session-delete`、`npm run test:e2e:recovery` | 全部通过：停止不再产生晚到进度、tombstone 可恢复且隔离同级会话、崩溃讨论仅变为可唤醒不会自动重跑 |
| 2A 定向边界 | Context management、L0、tool loop、Runtime service 4 个 spec | 58 / 58 通过：1,000 历史/101 候选有界、L0 防污染、旧工具结果引用化、迟到结果只结算一次 |
| 工程门禁 | `npm run test:harness` | 退出码 0，全部子门禁通过 |
| Server 全量 | 198 个 spec（`tsx --test --test-force-exit --tsconfig apps/server/tsconfig.json`） | 1390 项：1380 通过、10 跳过、0 失败 |
| 类型检查 | `npm run typecheck` | 退出码 0，全部 workspace 0 错误 |
| **`npm run test`（验收命令）** | 项目自带脚本 | **退出码 0，全绿**：cli 83/83、shared 107/107、server 1380 通过 + 10 跳过、web 60 文件 288 项、dev-supervisor 37/37、desktop 13/13；耗时约 4 分钟（此前挂起不退出，已修，见第 6 节） |
| **`npm run build`（验收命令）** | 项目自带脚本 | **退出码 0**：local runtime CLI、shared、server、desktop、Web 全部构建成功；仅有既有的 bundle 体积告警，无构建失败 |
| 符号链接越界守卫 | `workspace-symlink-guard.spec.ts` + `artifact-cutover-cleanup.spec.ts`（`--test-reporter=tap`） | 15 / 15 通过，0 跳过、0 失败；TAP 输出 5 条 `# escaping link carrier: junction` 自证走的是真实重解析点 |

已执行且作为证据：`test:e2e:token-budget`、`test:e2e:work-item-budget-recovery`、`test:e2e:client-presentation`、`test:e2e:phase-2a-routing`、`test:e2e:phase-2a-client-sse`、`test:e2e:session-delete`、`test:e2e:cancel`、`test:e2e:recovery`、`test:e2e:chinese-copy`、`npm run test`、`npm run build`、`npm run test:harness`。未执行并因此**不作为通过依据**：真实付费模型与真实多模态 Provider 验证；当前没有这类已配置适配器。

Server 全量此前的 3 项失败位于符号链接越界守卫（第 4 节），现已全部闭合：`path-safety.ts` 改为失败关闭，两个 spec 的 fixture 改为「文件符号链接 → junction 回退」并以 `lstat` 核实链接真实性，3 个用例由失败转为**真实通过**（server 通过数 1377 → 1380，跳过数保持 10）。10 项 skip 为平台/可选环境用例（含未设 `RELATIONAL_TEST_DATABASE_URL` 时的 PostgreSQL 集成用例）。

守卫本身的正确性另用一次性独立探针交叉验证（探针脚本已随本轮收尾清理）：对穿过 junction 的越界路径，`assertWithinRootRealpath` 与 `assertWorkspacePathWithinRoot` 均抛「路径越界（含符号链接）」；而只做路径字符串运算的 `safeJoin` 按设计放行——这正是二者必须成对使用的原因。

**顺带消除了一处「假通过」反模式**：`workspace-symlink-guard.spec.ts` 原先在 fixture 不可用时写 `if (result.skipped) assert.ok(true)`——这会让安全边界**零覆盖却显示绿色**，且不计入 skipped 计数，从报告上无法与"真的验证了"区分。已改为真 `t.skip(reason)`（计入 skipped）+ `t.diagnostic` 输出载体类型。因此本轮结论不依赖"通过数上升"这种可被假通过同样满足的间接推断，而是有 TAP 载体诊断作为直接证据：5 条 `# escaping link carrier: junction` 恰好对应 5 个使用该 fixture 的用例。同时把 junction 重解析点的清理移入 `finally`，避免断言失败时递归清理穿过联接误删外部文件。

本阶段开工时曾存在 7 个 TypeScript 编译错误（`generic-llm-runtime.service.ts` 缺 `llmInputSafetyMarginRatio` 导入、catch 分支误用未定义的 `selectedModel`；`generic-llm-tool-loop-budget.spec.ts` 误用 `responses`、`details.round` 类型未收窄；`debug-guard.spec.ts` 构造参数类型不符）。**这些错误没有阻断 `npm run test`，因为 tsx 会剥离类型**，其中一个 `ReferenceError` 被兜成 `MODEL_ERROR`，掩盖了真实原因。已全部修复；`generic-llm-tool-loop-budget.spec.ts` 断言中的英文 `/Estimated input tokens/` 改为断言中文 `/输入预算不足/` 并加强为“消息必须引用触发拦截的估算值”，理由是 `tests/e2e/chinese-visible-copy-smoke.mjs` 明确禁止英文 “Token budget exceeded” 出现在用户可见文案。

本阶段实现期间还有两处**由既有用例当场抓住的真实回归**，均已修复并留证据：一是把预算结算 `await` 进运行时监督流程，破坏了「未确认停止屏障不被迟到进程结果拖住」的语义，`runtime.service.spec.ts` 第 8 条用例直接挂死；二是新增集合时漏了 seed 状态与 schema COMMENT 两处登记，被 `cutover-context-v2-cli.spec.ts` 与 `relational-schema.spec.ts` 拦下。这两条说明该仓库的既有门禁是有效的——**遗漏会被测试抓到，前提是真的跑它**。

## 6. 未达成项与遗留风险（不得据此宣称通过）

1. **`npm run test` 挂起不退出（已修复）**：原因是 `@agent-cluster/local-runtime-cli`、`@agent-cluster/server`、`@agent-cluster/shared`、`@agent-cluster/desktop` 与根 `test:dev-supervisor` 的 npm 脚本使用不带 `--test-force-exit` 的 `tsx --test` / `node --test`，测试跑完后进程因未关闭句柄空转（`local-runtime-cli` 实测挂 10 分钟无输出）。已逐个脚本加上 `--test-force-exit`，验收命令从"永久挂起"变为约 4 分钟跑完并返回退出码 0。**遗留风险**：`--test-force-exit` 是掩盖未关闭句柄的止血手段，真正的句柄泄漏（定时器、连接池、子进程）尚未定位；在 CI 上若出现资源竞争，建议后续用 `--test-force-exit=false` 复现并根治。
2. **适配器覆盖边界**：真实付费模型与多模态 Provider 未接入；当前 `generic_llm` 为字符串消息适配器，多模态计数不适用。后续接入新 Provider 时，必须单独验证 provider 实际请求/用量计数、取消回执和回退演练，不能复用本阶段的 mock / generic LLM 结论。
3. **预算恢复边界**：取消、删除、迟到结果及恢复的当前账本语义已经过 E2E/故障注入覆盖；生产 Provider 的异步计费回执行为尚不可在未配置 Provider 的本地环境中验证。
4. **符号链接越界守卫缺陷（已修复）**：`path-safety.ts` 的 ENOENT 回退过宽——`realpath` 无法解析时降级为字面比较并放行。已改为失败关闭：`lstat` 成功但 `realpath` 抛 `ENOENT`（悬空链接）一律按越界拒绝，只有路径确实不存在时才向上爬父目录。同时修正 fixture 的信任来源（`lstat` 而非 `symlink()` 返回值）并增加 junction 回退，使这 3 个用例在本机由"失败/跳过"转为**真实验证通过**。**注意**：junction 回退覆盖的是"目录型越界链接"，文件符号链接路径在 Linux CI 上才真正执行；两者拦截逻辑相同（都经 `realpath` 比对），但载体不同，不能互相替代。
5. **仓库未提交**：T1–T6 的实现、用例与本轮修复是否已入库，以提交记录为准，本文件不做声明。
