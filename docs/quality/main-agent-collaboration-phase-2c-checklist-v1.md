# 阶段 2C：分层缓存、失效治理与成本观测 — Checklist v1

> 日期：2026-09-16
> 状态：**已通过验收（2026-09-19）**。证据见第 1 节矩阵与第 5 节实施记录；priceVersion 与真实付费模型抽样归阶段 6「形成质量与成本报告」任务。
> 依赖：阶段 2A、2B 通过；所有缓存必须服从阶段 1 生命周期。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-2c-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-2c-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-2c-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-2c-checklist-v1.md)

## 1. 验收矩阵

| 验收 ID | 关联任务 | 场景与预期 | 状态/证据 |
| --- | --- | --- | --- |
| P2C-AC1 | P2C-T1、P2C-T2、P2C-T4、P2C-T6 | 命中上下文包后仍进行发送前预算检查；高命中但输入超窗时仍拒绝，不通过缓存绕过 2A。 | **系统级通过（2026-09-19，mock runtime）**。`npm run test:e2e:context-bundle-cache`（`tests/e2e/context-bundle-cache-smoke.mjs`）起真服务：(A) 正常会话跑到 COMPLETED，`/ops/workspace-metrics` 上 `context_bundle_cache_total{outcome=hit}` = 2；(B) **同一个** 预算 10 的会话，第一次尝试 miss + `TOKEN_BUDGET_EXCEEDED`，发 `继续` 重试后 **hit +1 且第二次仍 `TOKEN_BUDGET_EXCEEDED`**。路径级：`context-bundle-cache.spec` 命中后 `budget` 与新建 deepEqual。结算侧按 `logicalInputTokens` 计入需求预算。**未做**：真实付费模型下的同一场景。 |
| P2C-AC2 | P2C-T1、P2C-T3、P2C-T6 | 同 Agent 的 A/B 会话不得交换内容；删除后到达的回填被拒绝；恢复后旧 generation 缓存不复用。 | **原语级通过（2026-09-18）**。`derived-cache.spec` 8/8：B 持 A 的 key 读不到、`invalidateSession` 只清本会话、恢复后旧 generation 未命中、丢失作用域的回填 `set` 返回 false 且 `rejectedBackfills+1`。`cache-contracts.spec` 私有 key 含 session/workItem/agent/generation，公共 key 不含 session 字样。系统级（真实删除/恢复流程）未验。 |
| P2C-AC3 | P2C-T2、P2C-T3、P2C-T6 | 修改相关文件只使依赖它的分析失效；无关进度事件不改变稳定上下文指纹。 | **原语级通过（2026-09-18）**。`cache-contracts.spec`：六项依赖任一变化指纹即变；心跳字段按名读取结构上进不了指纹；文件 hash 顺序无关。`derived-cache.invalidateFingerprint` 按指纹后缀清理。未接入真实文件变更事件。 |
| P2C-AC4 | P2C-T3、P2C-T6 | 百个相同请求仅一个有效构建提交；缓存宕机不会发起无限摘要或绕过调用总预算。 | **原语级通过（2026-09-18）**。`cache-single-flight.spec` 8/8：100 并发同 key → 1 次构建、恰一个 `owner:true`；构建失败不做负缓存；连续失败达阈值 → `circuit_open` 不再打原点，熔断按 key 独立。"回源仍受总预算"依赖 2A 预算门禁，本阶段未新增绕过路径。跨进程 single-flight **未做**。 |
| P2C-AC5 | P2C-T1、P2C-T4、P2C-T6 | 不支持缓存的模型正常执行并标注 unsupported；请求已配置但无回执用量时标记 unknown，不假定命中。 | **三条 runtime 路径通过（2026-09-18）**。能力声明：`runtime-cache-capability.spec` 8/8 + `generic-llm-token-estimation.spec` 新增用例，未声明 model → `unknown`、第三方 host → `unsupported`，两者 `blocksExecution:false` 正常执行，每次 generic-llm run 写 `tokenEstimation.cacheCapability`。无回执 → `unknown`：generic-llm `toUsage`、claude_code / codex 的 `usage-from-frames.spec` 6/6 均断言无 usage 帧时 `measurement:'unknown'` 且不伪造 cacheRead 计数。决定不单独记录 CLI 内建缓存能力（平台不控制 CLI 提示词，声明恒为 unknown，见 tasks T4）。 |
| P2C-AC6 | P2C-T1、P2C-T5、P2C-T6 | 不同 usage fixture 映射正确，缺失字段为 unknown；实际金额缺价格版本时不可伪造为零。 | **generic-llm 路径通过（2026-09-18）**。`cache-contracts.spec`：anthropic（input 不含 cache，logical = input + read）/ openai（input 含 cache，不重复加）/ ollama（unknown）；raw 缺失 → 各字段 `undefined` 非 0；金额无 `priceVersion` 整个 cost 不出具；`summarizeUsageBreakdown` 按 attemptId 去重。`toUsage`/`mergeUsage`/`settleRequirementBudget` 已接线。价格版本实际来源归阶段 6「形成质量与成本报告」任务（在此之前金额一律不出具）；摘要额外成本单列未做。 |
| P2C-AC7 | P2C-T1、P2C-T2、P2C-T6 | 超容量/过期后正确回源；用户历史与决策仍在；安全/控制类动作不命中旧回答。 | **原语级通过 + 可观测（2026-09-18/19）**。`derived-cache.spec`：`maxEntries` 满时 LRU 逐出、过期读判失效并释放容量（`size` 归零）、`stats()` 只有计数不含正文。命中率已暴露：`context_bundle_cache_total{layer,outcome}`，outcome 互斥（hit/miss/expired/evicted/rejected_backfill），标签不含 session（用例断言 + E2E 断言）。"历史与决策仍在"由设计保证（缓存是派生态，不触碰原始记录）。"安全动作不命中旧回答"当前不适用：没有调用方把动作结果放进缓存。 |

## 2. 现有验证入口

以下命令从仓库根目录运行，是后续实施回归入口，本次文档交付未执行这些业务测试。运行 E2E 前检查脚本使用隔离环境/mock，不能默认连接当前业务服务或真实模型。

```powershell
npm run test -w @agent-cluster/shared
npm run test -w @agent-cluster/server
npm run test -w @agent-cluster/local-runtime-cli
npm run typecheck
npm run test:e2e:context-bundle-cache   # 2026-09-19 新增：AC1 系统级（mock runtime，起真服务）
```

相关既有测试：

- [build-envelope-from-context-assembly.spec.ts](../../apps/server/src/modules/context-v2/build-envelope-from-context-assembly.spec.ts)
- [workspace-metrics.spec.ts](../../apps/server/src/common/workspace-metrics.spec.ts)

## 3. 必须补充的测试

- [ ] 缓存依赖失效、跨进程 single-flight 和迟到回填测试（待新增；不能用现有冒烟脚本代替）。
  进度：依赖失效（`cache-contracts.spec`）、**进程内** single-flight（`cache-single-flight.spec`）、
  迟到回填拒绝（`derived-cache.spec`）已补；**跨进程** single-flight 未补（无持久化落点）。
- [x] 多 provider 缓存用量归一化 golden fixture（2026-09-18，`packages/shared/src/cache-contracts.spec.ts`：
  anthropic / openai / ollama 三种映射 + raw 缺失 → unknown + 无 priceVersion 不出具金额）。
- [ ] 有界缓存容量与回源成本测试（待新增；不能用现有冒烟脚本代替）。
  进度：容量上限/LRU/TTL 已补（`derived-cache.spec`）；**回源成本**（miss 后重建的 Token 计入需求预算）
  未补：上下文包层 miss 后的重建成本走既有 2A 结算路径（`logicalInputTokens`），未单独计量。

## 4. 跨阶段安全复核

- [ ] file/PostgreSQL 行为对等；涉及并发的场景用独立 PostgreSQL 和独立连接/实例验证，不只使用 mock。
  本阶段不适用：未新增持久化集合。
- [ ] 重复、乱序、重启、取消/删除、迟到结果均不破坏幂等与版本边界。
  原语级：attemptId 幂等（`summarizeUsageBreakdown`）、迟到回填拒绝、旧 generation 未命中已验；系统级未验。
- [ ] 未确认范围、高风险动作、未知停止状态均不会被摘要/缓存/模型判断绕过。
  本阶段未新增任何绕过路径；上下文包缓存在 envelope 阶段、预算守卫之前，命中不跳过任何检查。
- [ ] 双端保持同一业务状态和各自样式；不依赖刷新才能修复状态。
  本阶段未改双端。
- [x] 无凭据、完整敏感提示或用户私有正文进入测试报告与指标（2026-09-18，用例断言：
  `derived-cache.stats()` 不含缓存正文；`normalizeRuntimeUsage` / `usageFromStreamFrame`
  序列化不含 `prompt` / `sk-`）。
- [ ] 所有文档/合同更新与实际实现一致，回退方案已演练或明确未执行。
  文档已按实际同步（本文件 + tasks + TASK.md）；回退：全部为加法字段与新文件，删除新文件并回退
  `toUsage`/`settleRequirementBudget` 两处改动即可，**未演练**。

## 5. 证据记录

每个结果记录：日期、构建/工作树版本、执行环境、fixture、命令、退出码、观察结果和证据路径；未执行/跳过必须写原因，不能记作通过。真实模型验证与 stub 验证分开记录。

阶段通过条件：失效/隔离/并发/容量测试通过；成本可解释，未知值不伪装为零；缓存不可绕过预算或真实执行。

本次初始状态：所有业务验收待验证；只完成 SDD 文档编制，不代表功能已经开发或上线。

### 2026-09-18 实施记录（stub 验证，未调用真实模型）

- 工作树：`main` @ `8f2a305` + 未提交的 2C 改动（14 个文件，见 `git status`）。
- 环境：Windows 11，Node v20.19.6，`npm run test` 走仓库自带 runner（`--test-force-exit`）。
- 定向：`cache-contracts.spec` 15/15、`derived-cache.spec` 8/8、`cache-single-flight.spec` 8/8、
  `runtime-cache-capability.spec` 8/8、generic-llm 四个 spec 47/47、`runtime.service.spec` 36/36。
- 全仓：`npm run typecheck` exit 0（五 workspace）、`npm run test` exit 0（shared 122 / server 1463 全过）、
  `npm run test:harness` exit 0、`npm run build` exit 0。
- 踩坑记录：(1) shared 不能 import `node:crypto`（web/desktop 消费），指纹改为规范化字符串；
  (2) 新模块必须从 `packages/shared/src/index.ts` 导出并重建 dist，否则 server 侧报
  `does not provide an export named`；(3) 带 Nest 装饰器的 server spec 必须以 `apps/server` 为 cwd
  跑 tsx，从仓库根跑会报 `Parameter decorators only work when experimental decorators are enabled`
  ——这是 tsconfig 解析位置问题，不是代码缺陷。

### 2026-09-19 追加（mock runtime E2E，未调用真实模型）

- 新增 `tests/e2e/context-bundle-cache-smoke.mjs`（`npm run test:e2e:context-bundle-cache`），exit 0。
  两台隔离 smoke 服务：正常会话 COMPLETED 后 `context_bundle_cache_total{outcome=hit}`=2；
  预算 10 的会话第一次 miss+拒绝，`继续` 重试后 hit+1 且第二次仍 `TOKEN_BUDGET_EXCEEDED`。
  同时断言该指标只带 layer/outcome 标签。
- 探针前置发现（写进 E2E 注释）：smoke 服务默认 workspace 为空，要求读文件的提示词会被
  grounded-evidence 门禁以 `CONTEXT_INSUFFICIENT` 拒绝，E2E 必须用不需要证据的提示词。
- 定向：`context-bundle-cache.spec` 10/10、`derived-cache.spec` 8/8、`usage-from-frames.spec` 6/6、
  `workspace-metrics.spec`（名字数守卫 38）；四门禁全绿。
- **阶段结论：已验收（2026-09-19，用户确认）。** 对照阶段通过条件——「失效/隔离/并发/容量测试通过」原语级 + E2E 已验；
  「成本可解释，未知值不伪装为零」三条 runtime 路径已接，未知一律 `unknown`；「缓存不可绕过预算或
  真实执行」已在真实服务上按同一会话的 hit→仍拒绝 验证。文件/摘要层不套缓存、CLI 能力声明不记录、
  跨进程 single-flight 延后，三项已在 tasks 文档写明理由关闭。
  **验收时决定**：(1) `priceVersion` 的实际来源与维护方式归阶段 6「形成质量与成本报告」任务——在此之前金额一律不出具
  （这是设计要求的诚实状态，不是伪零）；(2) 真实付费模型抽样归阶段 6「长会话成本评测」（roadmap §4）。
