# Context Engineering 治理执行方案 v1

> 创建时间: 2026-06-29
> 负责: Claude / Codex
> 跟踪文件: `docs/roadmap/context-engineering-remediation-v1.tasks.json`

## 1. 背景

用户在工作台绑定一个较大的本地目录后,会出现以下问题:

- workspace 扫描静默截断(`maxScannedEntries=350 / maxReadableFiles=80 / maxTotalContentBytes=550KB`),被截掉的范围只写在 `skipped[]` 数组里,**模型完全看不到自己漏看了什么**。
- `selectedEvidenceContents` 在装配时一次性塞进 prompt,runtime 没有"按需读取"的工具,稍大目录就 `TOKEN_BUDGET_EXCEEDED`。
- `relevantFiles` 评分纯靠路径关键词,中文需求/抽象问题打不上分,退化成"前 8 个可读文件"。
- 单文件统一 `slice(0, 8000)` 截断,可能切到函数中间。
- `CONTEXT_INSUFFICIENT` 重试限 1 次,多步探索能力被关死。
- 没有持久化扫描缓存,大目录每次重扫。
- `emergency` 之后无终极兜底,trim 失败 = 任务失败。

## 2. 目标

把"用户给一个目录 → ContextPack 装配 → runtime 执行"链路从"伪 ContextPack"升级为真正的 navigation packet:

1. 模型始终知道扫描了什么、漏看了什么。
2. 单文件截断按语义边界。
3. CONTEXT_INSUFFICIENT 支持多轮、可 dedupe、可观测。
4. 大目录有持久化缓存。
5. trim 失败前有 `navigation_only` 终极兜底,几乎不再硬 TOKEN_BUDGET_EXCEEDED。
6. 阶段注入矩阵作为代码 lint,违反契约直接抛错。
7. 全链路可观测、可治理。

## 3. 阶段总览

| 阶段 | 主题 | 优先级 | 涉及 task |
|---|---|
| A | 工作区扫描可观测(coverage 暴露) | P0 | T01-T04 |
| B | CONTEXT_INSUFFICIENT 多轮 + dedupe | P0 | T05-T07 |
| C | 单文件智能截断 + truncatedHint | P0 | T08-T10 |
| D | navigation_only 终极兜底 | P0 | T11-T13 |
| E | 文档与回归 | P0 | T14-T15 |
| F | 扫描缓存(浏览器 + 服务端) | P1 | 待拆分 |
| G | evidenceRefs 自适应 + workspaceIndex | P1 | 待拆分 |
| H | 阶段注入矩阵 lint | P2 | 待拆分 |
| I | embedding rerank + RuntimeReadTool | P2 | 待拆分 |

> 本文件只把 **P0** 部分拆分为可执行 task,P1/P2 在 P0 完成后再单独拆分。

## 4. 执行规则

1. **测试先行(TDD)**:每个 task 第 1 步必须先写出失败的测试用例,再写实现让测试通过。
2. **task 工时上限 20 分钟**:超时即停下来汇报,不私自扩大范围。
3. **每个 task 都是闭环**:目标 / 预期 / 步骤 / 结果 / 验证,验证不过则重做当前 task,不前进。
4. **进度落到 JSON**:每完成一个 task,更新 `context-engineering-remediation-v1.tasks.json` 的 `status` 与 `summary`,并把 `currentTaskId` 移到下一个 pending task。
5. **未完成的 task 不进 git 提交**:每个 task 完成且验证通过,**才**作为一次提交点(commit 由用户决定时机)。
6. **失败处理**:验证失败 → status=`failed` → 写 `failureReason` → 重新执行同一 task,直到通过。
7. **范围保护**:task 步骤之外的代码改动一律不做,发现新问题写到 `notes` 字段。

## 5. 通用验证命令

```bash
npm run typecheck
npm --workspace @agent-cluster/server run test
npm --workspace @agent-cluster/shared run test
npm run test:harness:phase1
```

涉及 e2e 的 task 各自指明命令。

## 6. P0 任务一览(详见 JSON)

| ID | 标题 | 阶段 | 预计 |
|---|---|
| T01 | WorkspaceManifestCoverage 类型 + 合同测试 | A | 15min |
| T02 | scanServerWorkspace 计算 coverage | A | 20min |
| T03 | 浏览器扫描 localWorkspace 计算 coverage | A | 20min |
| T04 | createWorkspaceManifest 注入 coverage | A | 15min |
| T05 | CONTEXT_INSUFFICIENT 重试次数配置化 | B | 20min |
| T06 | requestedContext dedupe | B | 15min |
| T07 | e2e: 多轮 CONTEXT_INSUFFICIENT 验证 | B | 20min |
| T08 | workspaceEvidenceContent 智能截断接口 + 单测 | C | 20min |
| T09 | TS/JS 智能截断实现 | C | 20min |
| T10 | Markdown 按 H2 截断 + truncatedHint | C | 20min |
| T11 | token.ts navigation_only stage 类型/接口 + 单测 | D | 20min |
| T12 | navigation_only stage 实现 | D | 20min |
| T13 | e2e: 极大目录场景验证 | D | 20min |
| T14 | 文档同步(ai-agent-context + harness-engineering) | E | 20min |
| T15 | 全量回归(typecheck + test + harness + 关键 e2e) | E | 20min |

## 7. 完成判定

- JSON 中 15 个 task 全部 `status=completed`。
- `npm run typecheck` `npm run test` `npm run test:harness` 全绿。
- 大目录(>500 文件)场景在 mock runtime 下可完成一轮 task_execution 不抛 TOKEN_BUDGET_EXCEEDED。

## 8. P1/P2 后续拆分(预告,不在本批 task 中)

- 扫描结果缓存(`.cache/workspace-scan/<hash>.json` + IndexedDB)。
- evidenceRefs 上限动态根据 budget 计算。
- WorkspaceIndex 控制面(SQLite + embedding rerank)。
- RuntimeReadTool(让 codex / claude_code 真正按需 grep/read)。
- `assertContextPackForPhase` lint。
- Token 预算可观测面板。

P0 完成后,在同目录追加 `context-engineering-remediation-v1.tasks.json` 的 P1/P2 区块。
