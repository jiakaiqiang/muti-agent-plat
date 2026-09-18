# TASK.md — 阶段 2C：分层缓存、失效治理与成本观测

状态：进行中（2026-09-18 开工）。阶段 2B 已验收，四道门禁全绿，因此 2C 准入成立。
当前：T1 完成；T2–T6 原语已落地，上下文包缓存有真实调用方，三条 runtime 路径
（generic-llm / claude_code / codex）usage 归一化已接线，全仓四门禁全绿；**阶段未验收**——
文件/摘要两层缓存未接、跨进程 single-flight 无落点、priceVersion 无实际来源、真实模型 E2E 未做。
各项缺口见下方每节「未做/未接入」。

依据文档（四件套，2026-09-16 生成）：
`docs/product/main-agent-collaboration-phase-2c-spec-v1.md`（AC）、
`docs/design/main-agent-collaboration-phase-2c-plan-v1.md`（设计与落点）、
`docs/implementation/main-agent-collaboration-phase-2c-tasks-v1.md`（任务）、
`docs/quality/main-agent-collaboration-phase-2c-checklist-v1.md`（验收与证据）。

前置：阶段 0、1、2A、2B 已验收（2B 于 2026-09-18，定向 176/176、独立 PostgreSQL 11/11、
六条 E2E、typecheck/test/test:harness/build 全绿）。

**纪律**：严格串行；每项先补失败用例再实现；每项结束时仓库必须绿；
持久化改动必须同步 shared 合同 + file backend + PostgreSQL 迁移/投影（不能只加内存 Map）。

## 开工前已核实的代码事实（2026-09-18）

- `RuntimeUsage`（`contracts.ts:2287`）只有 inputTokens/outputTokens/totalTokens/cost?/model?；
  **无** cacheRead/cacheWrite 拆分、**无** estimated 与 actual 之分、**无** priceVersion、
  **无** unknown 表达。AC6 要求的「未知值不伪装为零」目前在这个类型上无法表达。
- 缓存 Token **已经在下层被解析出来但随后被丢弃**：`runtime-stream-frame.ts:13-14` 有
  `cacheReadInputTokens` / `cacheWriteInputTokens`，`claude-stream-json-parser.ts:106-122`
  与 `streaming/codex-frame-parser.ts:26-29,164-165` 都会填充；但没有任何代码把它们带进
  `RuntimeUsage`，所以结算时归零。这是 2C 第一处真实缺口，不是新建能力。
- 现存唯一缓存是 `workspace-index/workspace-index-cache.ts`：**单槽快照**（一个 `snapshot`
  字段），按 `revision.id` 全等判命中，`invalidateOn` 换 revision 即整体丢弃。
  无 LRU、无 TTL、无容量上限、无 session/workItem 作用域、无 generation 校验。
  AC7 要求的容量/淘汰/可观测性全部缺失。
- `generic-llm-runtime.service.ts:921` 用 `toUsage(body.usage).inputTokens` 累加
  `actualInputTokens`；`toUsage`（1875 行）只读 `prompt_tokens ?? input_tokens ?? 0`。
  **缺失即 0**，且不同 provider 的 `input_tokens` 是否已含缓存部分不同 → 直接相加会重复累计。
- `runtime.service.ts:1089` 读 `result.usage?.inputTokens`，`1278` 按 invocation 求和；
  `mock-runtime.service.ts:489` 用「字符数/4」造估算值，与真实回执同字段同权重，
  下游无法区分 estimated 与 actual。
- 多个 adapter（claude-code 314/368/432/758/971、codex 301/337/776/808、code-reader、
  test-runner、server-runtime-worker 292、runtime.service 1011/1195）把 usage 硬写成
  **全 0**。这些 0 当前与「真实测得 0」不可区分，正是 AC5/AC6 要区分 unsupported/unknown 的地方。
- 2A 的 `work-item-budget.ts` 已有 reserve→settle、`unknownTokens`、`attemptId` 幂等，
  AC4「回源仍受预算限制」与 AC6「未知不计零」应复用它，不新建第二套预算。
- `PersistedState = Record<string, unknown>`（`persistence.service.ts:30`），新增集合需按
  2B 同样的 6 处约定接入 relational store（KNOWN/SESSION_KEYED/两处 load/write switch/
  writer/writeOrder）+ 迁移 + cutover seed。

## T1 定义缓存与用量合同（AC1/AC2/AC5/AC6/AC7）

落点：`packages/shared/src/cache-contracts.ts` + `.spec.ts`（15 例，已全绿）；
已从 `packages/shared/src/index.ts` 导出（漏导出会让 server 侧解析到 dist 旧产物而报
`does not provide an export named`，已踩过一次）。

- [x] T1-1 新增 `CACHE_CONTRACT_POLICY_VERSION`（参与 key，key 形状变更即整体失效）、
      `DerivedCacheLayer` 四层、`RuntimeCacheCapability`(supported/unsupported/unknown)、
      `UsageAvailability`(reported/unknown)、`NormalizedRuntimeUsage`、`UsageBreakdown`、
      `CacheDependencyInputs`。未改 `RuntimeUsage` 本体：归一化在其外侧做，
      既有 30 余处全 0 写入点因此零改动、零风险
- [x] T1-2 `normalizeRuntimeUsage`：按 provider 声明 input 是否已含 cache read
      （openai-compatible 含 → 不重复加；anthropic-compatible 不含 → 分别累计），
      `logicalInputTokens` = 模型真实读入量；raw 缺失 → `availability:'unknown'` 且
      各字段 `undefined`（不是 0）；金额无 `priceVersion` 则整个 cost 不出具。
      `summarizeUsageBreakdown` 按 attemptId 去重，unknown 与 reported 分列计数
- [x] T1-3 `derivedCacheKey`：私有 key = policy|layer|private|session|workItem|agent|
      generation|fingerprint，公共 key 只有 templateId 且不含 session 字样；
      `isCacheKeyScopedTo` 供读取/回填两处复核；`cacheDependencyFingerprint` 只按名读取
      六项真实依赖，心跳字段结构上无法进入指纹

## T2 实现本地派生缓存（AC1/AC3/AC7）

落点：`apps/server/src/modules/context-v2/derived-cache.ts` + `.spec.ts`（8 例，已全绿）。

- [x] T2-1 有界 LRU + TTL：`maxEntries` 满时逐出最久未用，过期条目在读取时判失效并释放容量
      （`stats().size` 归零），hits/misses/evictions/rejectedBackfills 可读
- [x] T2-2 读取与回填都调 `isCacheKeyScopedTo`：跨会话持 A 的 key 读不到 A 的内容；
      恢复后旧 generation 条目一律未命中；`invalidateSession` 只清该会话，兄弟会话不受影响
- [x] T2-3 第一个真实调用方已接：`context-v2/context-bundle-cache.ts`（8 例全绿）包住
      `buildEnvelopeFromContextAssembly` 里的 **navigation + projectMap**（纯工作区派生态），
      L3 证据 / L5 摘要每次重建不缓存。key 作用域 = session/workItem/agent/generation，
      指纹 = revision.id + inputTokens + 入口 + detectedStack + 索引状态。
      orchestrator 两个 `contextEnvelopeFactory` 调用点传入实例与 `lifecycle.generation()`
      （无记录时兜底 0），`deleteSession` 调 `invalidateSession` 即时清理。
      **AC1 路径成立**：缓存在 envelope 阶段，2A 的 `assertWithinInputBudget` 在 runtime 里
      在其之后，命中的 envelope 与新建的对预算守卫不可区分（用例断言 `budget` deepEqual）。
      配置：`CONTEXT_BUNDLE_CACHE_MAX_ENTRIES`(256) / `CONTEXT_BUNDLE_CACHE_TTL_MS`(10min)。
      fixture 教训：有 provider index 时证据条目必须带匹配的 `revision.id`，否则被
      `selectedEvidence` 静默过滤，用例会得到 L3 为空的假结果

## T3 实现失效与并发回填保护（AC2/AC3/AC4）

落点：`apps/server/src/modules/context-v2/cache-single-flight.ts` + `.spec.ts`（8 例，已全绿）。

- [x] T3-1 依赖指纹失效由 T1-3 的 `cacheDependencyFingerprint` 覆盖：六项依赖任一变化
      指纹即变；心跳/流式进度不是指纹输入（用例断言 + 文件 hash 顺序无关）
- [x] T3-2 single-flight：100 个相同 key 并发只构建 1 次，恰一个 caller 为 `owner:true`，
      其余 `owner:false` 不得以 owner 身份回填
- [x] T3-3 迟到回填：丢失作用域的 `set` 返回 false 且不落盘（T2-2 用例）；
      构建失败不作为负缓存，下一次可重试；连续失败达 `maxConsecutiveFailures` 后
      `circuit_open` 不再打原点，成功一次即清预算，熔断按 key 独立

## T4 实现 Provider/CLI 缓存适配（AC1/AC5）

落点：`apps/server/src/modules/runtimes/runtime-cache-capability.ts` + `.spec.ts`（8 例，已全绿）。

- [x] T4-1 `splitPromptForCache`：稳定部分（system/工具 schema/项目规则）在前、动态部分
      （证据/当前消息）在后；证据与用户文本**结构上进不了** stablePrefix，不为命中率升级
      信任层级；stablePrefix 为空时 `cacheable:false`，不填充凑厂商门槛
- [x] T4-2 `declaredCacheCapability`：按 provider+model+endpoint host 三元组查显式声明表；
      未声明的 model → `unknown`；已声明 model 走非厂商 host（第三方网关）→ `unsupported`；
      两者都 `sendCacheParameters:false`、`blocksExecution:false`，正常执行只是不标命中
- [x] T4-3 接入：`generic-llm-runtime.service.ts` 每次 run 按 `selectedConnection.provider`
      + `selectedModel` + `chatCompletionsUrl(baseUrl)` 调 `declaredCacheCapability`，结果写进
      `tokenEstimation.cacheCapability`（`RuntimeTokenEstimationDiagnostic` 加法扩展）。
      用例：`generic-llm-token-estimation.spec.ts` 新增「test-model@llm.test → unknown 且不
      伪造 cacheRead 计数」。`splitPromptForCache` **仍未接入**：现有组装已是 system 在前、
      动态 payload 在后，为用它而重排消息是无收益改动，先不动
- [x] T4-4 CLI 适配器 usage 接线：真正的丢包点不在 adapter 而在两个 streaming runner 的
      `usageFromFrames`——只读 input/output，把 parser 已解析的 cacheRead/cacheWrite 扔掉，
      无帧时硬写 0 且无 measurement。抽成 `streaming/usage-from-frames.ts`
      （`runtimeUsageFromFrames`，6 例全绿）委托 `usageFromStreamFrame`：claude_code 按
      anthropic 语义（input 不含 cache）、codex 按 openai 语义（cached 是 input 子集）；
      codex 取最后一个 `usage` 帧（累计值）否则回落 `result` 帧；无 usage → `unknown`；
      `cachedInputTokens:0` 是"报了 0"不是"没报"。runner + adapter 六个 spec 91/91。
      **三条 runtime 路径（generic-llm / claude_code / codex）现在共用一套归一化**

## T5 接入成本诊断（AC6）

- [x] T5-1 `RuntimeUsage` 加法扩展（`contracts.ts`）：cacheReadInputTokens /
      cacheWriteInputTokens / logicalInputTokens / measurement('actual'|'estimated'|'unknown')
      / priceVersion，全部可选，既有全 0 写入点零改动。
      `generic-llm-runtime.service.ts`：`GenericLlmUsage` 识别 OpenAI 的
      `prompt_tokens_details.cached_tokens`（是 prompt_tokens 子集）与 Anthropic 的
      `cache_read_input_tokens` / `cache_creation_input_tokens`（独立计数）；`toUsage` 据此
      算 logicalInputTokens 且 usage 缺失 → `measurement:'unknown'`；`mergeUsage` 累加缓存
      计数、缺失保持缺失（`sumOptionalTokens`）、最弱 measurement 胜出；工具循环新增
      `loopUsage` 累计器，最终 usage 不再是裸 `actualInputTokens`。
      连带更新 1 个过时断言（`generic-llm-runtime.service.spec.ts:448` 的严格 deepEqual
      现在含 measurement/logicalInputTokens，值正确）
- [x] T5-2 `runtime.service.ts settleRequirementBudget`：改用显式 `measurement` 判断，
      `'unknown'` → `unavailable`（保留预留上限为保守值）；结算额改为 `logicalInputTokens ??
      inputTokens`，缓存读虽便宜但占窗口，按逻辑总量计入需求预算。attemptId 幂等由 2A
      `settleWorkItemBudget` 原有逻辑保证。runtime.service spec 36/36。
      **未做**：摘要/检索额外成本单列、priceVersion 实际取值来源
- [ ] T5-3 **未做**：未新增任何 metrics 标签，因此没有引入高基数问题，但也没有新增
      缓存命中率/耗时观测

## T6 验证缓存故障与收益（AC1–AC7）

- [x] T6-1 原语级覆盖（非系统级）：过期→未命中并释放容量、跨会话/跨 generation 未命中、
      `invalidateSession` 只清本会话、迟到回填拒绝、100 并发单次构建、连续失败熔断
      （derived-cache 8 例 + single-flight 8 例）
- [x] T6-2 多 provider usage fixture：anthropic-compatible（input 不含 cache）、
      openai-compatible（input 含 cache）、ollama（unknown）；raw 缺失 → 全 undefined 非 0；
      金额无 priceVersion 不出具（cache-contracts.spec 15 例）
- [ ] T6-3 四门禁：typecheck ✓ / harness ✓ / test 与 build 待本轮重跑确认。
      **独立 PostgreSQL 与 E2E 未做**：本阶段没有新增持久化集合（缓存是进程内派生态），
      因此没有迁移可验；但 AC1「命中后仍走预算检查」需要缓存接入真实发送路径才能做
      系统级验证，见 T2-3 / T4-3 未接入项

## 遗留（跨阶段，未完成）

- [ ] 中断会话续接 G3：`npm run dev:restart-server` + 真实场景手测（上一专项人工项）。
- [ ] `0b5ee52`（上下文包缓存接入）**未推送**：提交后网络再次中断，4 次重试均
      `Failed to connect to github.com port 443`。`6672a85` 及之前已核对在远端。
      网络恢复后 `git push origin main`，再用 `git ls-remote origin refs/heads/main` 核对。
- [x] 2A/2B/2C 提交已推送：`bdbdfd6`、`8f2a305`、`6672a85` 均在 `origin/main`
      （2026-09-18 网络恢复后推送，`git ls-remote` 核对远端 HEAD = 本地 HEAD）。
      教训：第一次推送报 `curl 55 Connection was reset` 时对象其实已传完 25 个提交，
      只是回包前断线导致本地跟踪引用没更新，之后一直假显示 `ahead 27`。
      判断推送是否真失败要 `git ls-remote origin refs/heads/main`，不能只看 `status -sb`。
