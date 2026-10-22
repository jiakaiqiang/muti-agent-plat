# M-014 B / R10c Web 与 Desktop 卡片报告

## 结论

B 的 Web/Desktop 展示和提交链路已实现，共用现有 `ConfirmationCard`、`ChatTimeline`、`SessionWorkspace` 和 R9b 事实卡模式，没有新增页面，也没有修改服务端代码。

## 已实现

- `intent_source_authorization` 卡从 A 的候选接口搜索、分页和刷新；只渲染接口返回的候选引用，suggested 单独标记且默认不勾选；展示追加需求原文、禁止项和“批准后这些文件可能被自动修改并写回”警示；批准体只含 `candidateRefs`、CAS 版本和稳定幂等键，409/过期引用提示重新读取。
- FollowUp 状态卡显示 queued / blocked（含原因）/ brief / ready / running / waiting_budget / cancelled 等服务端状态；queued 和 brief 才显示“取消这条追加需求”。
- `source_writeback` 复用 R9b 案件证据视图，展示 baseHash / targetHash / currentHash；redispatch、confirm_completed、abandon 三个动作按服务端返回的 enabled/reason 渲染。
- Desktop renderer 通过现有 `@/* -> apps/web/src/*` 共享 store、合同和卡片实现，另补齐 Desktop ChatTimeline 的事件字段归一化。

## 验证

- Web Vitest 全量：103 个测试文件，580/580 通过；其中新增授权、FollowUp 状态/取消、source_writeback 三个组件测试全部通过。
- Desktop package tests：14/14 通过。
- `npm run typecheck -w @project/web`：通过。
- `npm run typecheck -w @agent-cluster/desktop`：通过。
- `npm run build -w @project/web`：通过。
- `npm run build -w @agent-cluster/desktop`：通过。

## 服务端现状限制

FollowUp 服务已有 `IntentFollowUpService.cancel()`，但当前 `sessions.controller.ts` 没有暴露单条追加需求取消路由。卡片按 R10c 的前端范围保留取消操作，并在服务端返回 404 时明确提示“当前服务端未提供单条追加需求取消接口”；本轮未新增服务端路由，避免违反 B 的“不改服务端”约束。候选授权和写回对账均使用已存在且已验证的服务端接口。

## 范围与限制

B 只修改 web/desktop 类型归一化、共享 store 和卡片；未修改编译器、`execution-scope-resolver`、semantic-intent-router、`intent-runtime-policy.ts`、默认开关、`.env`，未调用真实模型、未提交或推送。构建中的既有 Rollup 大 chunk / Element Plus 注释警告不影响退出码。

## M-015 / R10c r2 修复与验证（2026-10-22）

### 修复

- 候选扫描在遍历时按路径 query 过滤；500 条上限只作用于匹配结果。新增独立条目数/耗时预算，预算耗尽返回 `truncated` 与 `truncatedReason`；非匹配文件只检查路径和元数据，匹配文件才读取全文并计算 hash。
- 新增 `POST /sessions/:sessionId/intent-follow-ups/:followUpId/cancel`。请求校验 `expectedRevision` 与 `idempotencyKey`，取消结果按同键持久化重放；queued/brief 可取消，cancelled/ready 或 revision 冲突返回 409，取消不会创建派发。
- 前端取消卡片使用正式取消接口，成功后立即显示 cancelled，409 刷新事实且不自动重投；移除旧的 404 特殊提示。候选卡在过期/409 后刷新并要求重新选择，展示扫描结果不完整提示；写回卡测试覆盖服务端返回的 hash mismatch disabled/reason。

### 验证与证据

- 服务端定向 `intent-follow-up.service.spec.ts`：15/15 通过，包含 610 个文件、四层深路径、预算截断原因、queued/brief 零派发、cancelled/ready 409、同键重放。
- 服务器回归（排除两个既有基线夹具）：280 files，2496 tests，2453 passed，0 failed，43 skipped；完整日志见 `evidence/r10a-r10b-regression-r2.log`。排除项及原因已写入 `evidence/verification-r2.json`。
- `npm run typecheck -w @agent-cluster/server`、`npm run build -w @agent-cluster/server` 通过。
- Web Vitest：103 files / 582 passed；Desktop package tests：14 passed；Web/Desktop typecheck 与 build 均通过。
- SHA-256 与命令记录见 `evidence/verification-r2.json`。未跑真实模型，未提交、未推送。

## M-016 / R10c r3 收尾验证（2026-10-22）

- R9 对账回归按仓库根目录 `tsx` 命令单独运行：38/38 通过；完整输出见 `evidence/r9-reconciliation-r3.log`。
- `cutover-context-v2-cli.spec.ts` 当前仍为既有基线失败（缺少 `intentReconciliationsBySession` seed key）；在基线提交 `5ded526` 的隔离 worktree 中同一测试为 11/11 通过，因此该失败不是 M-016 或 R10c 变更引入。
- 源码授权卡新增“服务端决定/候选状态在重新挂载后恢复”和“快速重复点击只调用一次 `decideIntentSourceAuthorization`”两条测试；定向 4/4 通过。Web 全量 103 files / 584 passed。
- Desktop renderer 没有源码授权、追加需求状态、源码写回对账卡的独立副本：`apps/desktop/vite.renderer.config.mjs` 将 `@` alias 指向 `apps/web/src`，`apps/desktop/renderer/components/ConfirmationCard.vue` 直接导入 `@/components/IntentSourceAuthorizationCard.vue`，相关状态/对账组件同样由 web 提供；desktop 复用 web 组件，由 web 测试覆盖。
- Desktop package tests 14/14 通过；Web `vue-tsc`、desktop renderer `vue-tsc` 和 desktop 主进程 typecheck 均通过。命令、结果与 SHA-256 见 `evidence/verification-r3.json`。
- 未修改服务端产品代码，未运行真实模型，未提交或推送。

## M-017 / R10c r4 seed 回归修复（2026-10-22）

### 修复与差集核对

- 在 `apps/server/src/modules/persistence/cutover-context-v2.cli.ts` 的 `buildV2SeedState()` 补齐 `intentReconciliationsBySession: {}`，对应 R9a 的 `intent_reconciliations` 集合。
- 实际调用 `relationalCollectionKeys()` 与 `buildV2SeedState()` 做集合差集核对，排除 `systemDataMetadata`、`cutoverAudits`：修复前 missing 为 `[intentReconciliationsBySession]`，extra 为空；修复后 relational 50 项与 seed 50 项完全一致，missing/extra 均为空。

### 验证

- `cutover-context-v2-cli.spec.ts`：11/11 通过。
- R9 `intent-reconciliation.service.spec.ts`：38/38 通过。
- R10a–R10c `intent-follow-up.service.spec.ts` 定向回归：15/15 通过，达到上一轮定向项数。
- `npm run typecheck -w @agent-cluster/server`：通过。
- `npm run build -w @agent-cluster/server`：通过。
- server 全量回归尝试为 2545 项：2500 通过、2 失败、43 跳过。两项失败分别是 M015 深层搜索在全量并发资源条件下的时序敏感失败（定向 15/15 通过），以及 R9a 真实进程测试从 `apps/server` 子路径寻找缺失的 `apps/server/node_modules/tsx/dist/cli.mjs`（仓库根目录 tsx 定向运行 38/38 通过）；均未改变本次 seed 修复结论。

证据：`evidence/verification-r4.json`。本轮只修改上述 seed 文件，未改测试、编译器、范围解析器、semantic-intent-router、`intent-runtime-policy.ts`、默认开关或 `.env`；未运行真实模型，未提交、未推送。

## M-018 / R10c r5 测试稳态修复（2026-10-22）

### 修改

- `intent-reconciliation.service.spec.ts` 不再依赖 `npm run test -w` 的当前目录：通过 `createRequire(import.meta.url).resolve('tsx/cli')` 定位根目录 tsx，按模块位置定位 `apps/server/tsconfig.json`，并以模块推导的仓库根解析子进程内联脚本的绝对文件 URL。
- `intent-follow-up.service.spec.ts` 的 M015 深层搜索用例显式传入 `scanBudget.maxMs = 10_000`，条目预算仍使用生产默认；610 个普通文件并行创建在临时 `.gitignore` 噪声目录中，保留超过 500 条遍历和四层深目标，只验证遍历时 query 过滤及匹配结果上限。生产默认 2 秒未修改。

### 验证

- 定向合计 64/64：cutover 11/11、R9 对账 38/38、R10a–R10c follow-up 15/15。
- `npm run test -w @agent-cluster/server` 连续两次均全绿：每次 unit 2545 项（2502 通过、0 失败、43 跳过），随后 dev 测试 7/7，退出码 0。
- 证据：`evidence/verification-r5.json`；两次完整日志分别为 `.tmp/m018-final-1.log`、`.tmp/m018-final-2.log`。

本轮只修改上述两个 spec 文件；未修改生产代码、默认值、受保护模块或 `.env`，未运行真实模型，未提交、未推送。

## M-019 / R10c r6 判别力验证（2026-10-22）

- 监督方移除 M015 深搜夹具中的 `.gitignore` 后，当前实现定向通过：1 passed、0 failed、14 skipped，exit=0。
- 为验证判别力，临时将 `intent-source-authorization-candidates.ts` 恢复为“广度优先先扫满 500 个常规文件，再按 query 过滤”的旧行为。红测 exit=1，实际结果为空，测试期望 `z1/z2/z3/z4/needle.ts`；说明该夹具能识别 M-015 前的错误行为。
- 恢复当前实现后再次绿测：1 passed、0 failed、14 skipped，exit=0。产品文件 SHA-256 前后均为 `7639E9F5F89C4C3626B489095880583C11FAE0DA3F1F87CFFA6E0583CB3AD351`；临时版本为 `0757A9B0CB4DFD11B74B35BAC6D0A546C03320A0F19DA99654BD82EC0BCAE6C0`，临时备份已删除，工作区未保留临时改动。
- `npm run test -w @agent-cluster/server`：unit 2545（2502 passed、0 failed、43 skipped），dev 7/7，exit=0。完整输出见 `.tmp/m019-server-test.log`，结构化证据见 `evidence/verification-r6.json`。

本轮仅为验证做了可恢复的临时产品文件替换并已恢复；未跑真实模型、未提交、未推送。
