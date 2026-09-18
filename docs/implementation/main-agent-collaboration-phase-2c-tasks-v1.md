# 阶段 2C：分层缓存、失效治理与成本观测 — Tasks v1

> 日期：2026-09-16
> 状态：实施中（2026-09-18 开工）。T1 完成；T2–T6 原语落地，上下文包缓存有真实调用方，
> 三条 runtime 路径 usage 归一化已接线并全绿；但文件/摘要层未接、跨进程 single-flight 无落点、
> 系统级/E2E 未做，**阶段未验收**。
> 依赖：阶段 2A、2B 通过；所有缓存必须服从阶段 1 生命周期。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-2c-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-2c-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-2c-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-2c-checklist-v1.md)

## 执行规则

- 所有任务初始为待实施；先确认前置阶段退出条件，不跳过安全与确认门禁。
- 每项先补合同/失败用例，再实现；数据库、模型、CLI 与双端边界分别验证。
- 复用现有能力仍需回归，不将既有专项的通过记录直接复制为本阶段通过。
- 本轮只生成文档；以下路径与改动是后续开发范围，不是已完成修改。

## 任务清单

### P2C-T1 定义缓存与用量合同

- [x] 完成实现与审查（2026-09-18）。
- 前置：阶段 2A、2B 通过；所有缓存必须服从阶段 1 生命周期。
- 交付：分层 key、依赖、容量、隐私作用域、usage 原始/归一化字段和能力声明。
- 覆盖：P2C-AC1、P2C-AC2、P2C-AC5、P2C-AC6、P2C-AC7。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 证据：`packages/shared/src/cache-contracts.ts` + `.spec.ts` 15/15；`RuntimeUsage` 与
  `RuntimeTokenEstimationDiagnostic` 加法扩展（`contracts.ts`），既有全 0 写入点零改动。
  实施教训：shared 被 web/desktop 消费，不能 import `node:crypto`，指纹改为规范化字符串。

### P2C-T2 实现本地派生缓存

- [ ] 完成实现与审查。
- 前置：P2C-T1 完成；涉及的其他阶段依赖同页顶部。
- 交付：文件、摘要、上下文包缓存及 LRU/TTL，复用现有索引实现。
- 覆盖：P2C-AC1、P2C-AC3、P2C-AC7。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 进度（2026-09-18）：通用有界缓存 `apps/server/src/modules/context-v2/derived-cache.ts`
  已落地并测试 8/8（LRU/TTL/作用域/迟到回填拒绝/计数不含正文）。
  **第一个真实调用方已接**：`context-bundle-cache.ts`（8/8）缓存 `buildEnvelopeFromContextAssembly`
  的 navigation + projectMap（上下文包层），orchestrator 两处 `contextEnvelopeFactory` 传入实例与
  lifecycle generation，`deleteSession` 即时失效；配置 `CONTEXT_BUNDLE_CACHE_MAX_ENTRIES` /
  `CONTEXT_BUNDLE_CACHE_TTL_MS`。
- 决定（2026-09-19）：**文件层与摘要层不再套派生缓存。** 文件层 `workspace-index-cache.ts` 按
  workspace revision 单槽持有，"只保留当前 revision"正是它该有的失效语义，换成 LRU/TTL 没有收益；
  摘要层 2B 的 `SummaryCheckpointStore` 已是按逻辑键（含 coveredEventSeq/版本）的持久化读写，
  `latest()` 直接命中，再叠一层进程内缓存只会引入第二份真相。四层里真正需要派生缓存的是
  上下文包层，已接。此项按"不做，理由如上"关闭，不再作为缺口挂着。

### P2C-T3 实现失效与并发回填保护

- [ ] 完成实现与审查。
- 前置：P2C-T2 完成；涉及的其他阶段依赖同页顶部。
- 交付：业务指纹、generation、跨进程唯一提交、single-flight 和有限回源。
- 覆盖：P2C-AC2、P2C-AC3、P2C-AC4。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 进度（2026-09-18）：业务指纹与 generation 校验由 T1 合同覆盖；进程内 single-flight
  `cache-single-flight.ts` 8/8（100 并发 → 1 次构建、失败不做负缓存、按 key 熔断）。
  **延后（2026-09-19 决定）**：跨进程唯一提交——本阶段没有新增持久化集合，缓存是进程内派生态，
  跨实例竞争没有落点；单实例部署下进程内 single-flight 已覆盖 AC4 的"百个相同请求一个构建"。
  若后续多实例部署需要，按 2B 检查点 store 的唯一逻辑键 + 短租约模式补，届时作为独立任务立项。

### P2C-T4 实现 Provider/CLI 缓存适配

- [ ] 完成实现与审查。
- 前置：P2C-T3 完成；涉及的其他阶段依赖同页顶部。
- 交付：按实际能力拆稳定/动态内容，unsupported/unknown 回退，不改消息权限。
- 覆盖：P2C-AC1、P2C-AC5。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 进度（2026-09-18）：`apps/server/src/modules/runtimes/runtime-cache-capability.ts` 8/8。
  `declaredCacheCapability` 按 provider+model+endpoint host 显式声明表判定，未声明 model →
  unknown、已声明 model 走第三方 host → unsupported，两者都不发缓存参数、不阻断执行；
  已接入 `generic-llm-runtime.service.ts`，每次 run 写进 `tokenEstimation.cacheCapability`
  （`generic-llm-token-estimation.spec.ts` 新增用例）。`splitPromptForCache` 已实现并测试
  （证据/用户文本结构上进不了稳定前缀、空前缀不填充），**未接入**：现有组装已是稳定
  system 在前、动态 payload 在后，为用它重排消息没有收益。**CLI 路径已接**：丢包点在两个
  streaming runner 的 `usageFromFrames`（只读 input/output，扔掉 parser 已解析的缓存计数），
  抽成 `streaming/usage-from-frames.ts`（6/6）后 claude_code 按 anthropic 语义、codex 按 openai
  语义归一化，无 usage 帧 → `measurement:'unknown'`；runner + adapter 六个 spec 91/91。
  **决定（2026-09-19）：CLI 内建提示词缓存的能力声明不单独记录。** claude_code / codex 的提示词
  由 CLI 自己组装，平台既不控制缓存断点也不发缓存参数（plan §2.5），所以平台侧的声明结构上
  恒为 `unknown`——记录一个常量不产生信息。AC5 对 CLI 路径真正要求的"无回执 → unknown、
  不假定命中"已由 usage 归一化落实。

### P2C-T5 接入成本诊断

- [ ] 完成实现与审查。
- 前置：P2C-T4 完成；涉及的其他阶段依赖同页顶部。
- 交付：归一化用量、价格版本、摘要额外成本、命中率和耗时，不记录敏感正文。
- 覆盖：P2C-AC6。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 进度（2026-09-18）：generic-llm 路径打通——`toUsage` 识别 OpenAI
  `prompt_tokens_details.cached_tokens`（prompt_tokens 子集）与 Anthropic
  `cache_read_input_tokens` / `cache_creation_input_tokens`（独立计数），算出
  `logicalInputTokens`，usage 缺失 → `measurement:'unknown'`；`mergeUsage` 累加缓存计数且
  缺失保持缺失；工具循环 `loopUsage` 累计后作为最终 usage。
  `runtime.service.ts settleRequirementBudget` 改用显式 `measurement`：unknown →
  unavailable（保留预留上限），结算额取 `logicalInputTokens ?? inputTokens`；attemptId 幂等
  沿用 2A。用例：generic-llm 四个 spec 47/47、runtime.service 36/36。
  **未做**：价格版本实际来源与金额出具、摘要/检索额外成本单列、命中率与耗时 metrics。

### P2C-T6 验证缓存故障与收益

- [ ] 完成实现与审查。
- 前置：P2C-T5 完成；涉及的其他阶段依赖同页顶部。
- 交付：冷热请求、文件/需求变更、删除并发、缓存宕机、不同供应商 usage fixture。
- 覆盖：P2C-AC1、P2C-AC2、P2C-AC3、P2C-AC4、P2C-AC5、P2C-AC6、P2C-AC7。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 进度（2026-09-18）：原语级场景已覆盖（过期回源、跨会话/跨 generation 隔离、删除后
  回填拒绝、100 并发单构建、熔断、三 provider usage fixture 含缺字段 → unknown）；
  全仓 `npm run typecheck` / `test`（1463/1463）/ `test:harness` / `build` 全部 exit 0。
- 进度（2026-09-19）：**AC1 系统级 E2E 已落地**——`npm run test:e2e:context-bundle-cache` 起真服务
  （mock runtime）：正常会话产生真实命中（hit=2），预算 10 的会话重试时命中缓存仍被
  `TOKEN_BUDGET_EXCEEDED` 拒绝；命中率经 `/ops/workspace-metrics` 可读且不带 session 标签。
  **未做**：缓存宕机回源的端到端（当前是进程内 Map，没有"宕机"形态）；真实付费模型；
  独立 PostgreSQL 不适用（本阶段未新增持久化集合）。

## 完成定义

失效/隔离/并发/容量测试通过；成本可解释，未知值不伪装为零；缓存不可绕过预算或真实执行。

完成一个任务不等于阶段完成；所有 AC 必须有证据。最后同步相关合同、测试说明与 Checklist，不修改其他未通过阶段的状态。
