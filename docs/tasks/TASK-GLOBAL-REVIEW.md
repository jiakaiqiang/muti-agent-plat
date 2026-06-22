# 任务拆分全局审查报告

## 审查日期
2026-06-22

## 审查目标

检查 `docs/tasks` 下 13 个任务是否满足可执行、可验证、可按 TDD 推进的要求：

1. **时间控制**：每个任务 15-30 分钟内可独立交付。
2. **背景完整**：明确复用现有代码，不重复造轮。
3. **范围清晰**：包含/不包含边界明确。
4. **技术方案可落地**：示例代码与当前仓库合同一致。
5. **TDD 方法**：实现类任务必须先写测试，再写实现。
6. **验证命令**：每个任务都有最小可执行验证。
7. **风险边界**：高风险能力必须经过 capability/审计链路。
8. **向后兼容**：不破坏现有 Runtime、Tool、Orchestrator 行为。

---

## 审查结果总览

| 任务ID | 任务名称 | 时间 | TDD | 关键结论 |
| --- | --- | --- | --- | --- |
| TASK-001 | Runtime Adapter 合同扩展 | 15min | 是 | 扩展现有 `AgentRuntimeAdapter`，不新增第二套合同 |
| TASK-002 | Runtime Registry | 20min | 是 | 从现有 `RuntimeService` 抽注册表，保持执行门面 |
| TASK-003 | Tool 接口 | 15min | 是 | 区分内部可执行 Tool 与 shared descriptor |
| TASK-004 | Tool Registry | 15min | 是 | 支持注册、查询、descriptor 导出 |
| TASK-005 | FileReader Tool | 20min | 是 | 复用 `WorkspaceToolsService.readFile` |
| TASK-006 | 能力-工具映射 | 15min | 是 | 使用现有 capability id，例如 `cap-file-write` |
| TASK-007 | CodeReader Runtime Adapter | 30min | 是 | 先扩展 `RuntimeType`，再实现内部 Runtime |
| TASK-008 | Runtime 智能路由 | 20min | 是 | 显式处理 preferred runtime 与 fallback 原因 |
| TASK-009 | 任务索引 | 10min | 不适用 | 文档任务，用结构校验替代 TDD |
| TASK-010 | FileWriter Tool | 20min | 是 | 高风险写入，复用 `applyServerLocalFileChanges` |
| TASK-011 | CodeSearch Tool | 20min | 是 | 复用现有 workspace scan/search 能力 |
| TASK-012 | TestRunner Tool | 20min | 是 | 仅允许运行 package.json 中的受控测试脚本 |
| TASK-013 | TestRunner Runtime Adapter | 30min | 是 | 先扩展 `RuntimeType`，再接入 `run_test` 工具 |

**总体结论**：可以开始执行。当前任务拆分已经具备测试先行、最小验证和风险边界。

---

## 已处理的关键问题

1. **避免合同分裂**
   - TASK-001 改为扩展 `packages/shared/src/contracts.ts` 里的 `AgentRuntimeAdapter`。
   - 不再新增 `RuntimeAdapter`、`AgentRunInput`、`RuntimeResult` 第二套类型。

2. **消除 `RuntimeType` 类型逃逸**
   - TASK-007/013 不再建议对 `RuntimeType` 使用 `as any`。
   - 两个内部 Runtime 任务都要求先同步 `RuntimeType`、runtime config/label 和 smoke 测试。

3. **TDD 明确落地**
   - 每个实现类任务都有“测试先行（TDD）”章节。
   - 完成标准包含单测、typecheck 和必要的 e2e/smoke。
   - TASK-009 是文档任务，不强制 TDD，用链接/结构校验替代。

4. **高风险能力受控**
   - TASK-010 通过 `cap-file-write` 和 `previousContent` 冲突保护写文件。
   - TASK-012 通过 `cap-command-run`、package script 白名单、timeout/AbortSignal 控制测试命令。

5. **示例代码贴合现有系统**
   - Runtime 使用 `run(input, signal?)`。
   - Tool 复用 `WorkspaceToolsService`、`scanWorkspace`、`CapabilitiesService` 等现有能力。

---

## 仍需注意

1. **文件名仍保留 `agent`**
   - `TASK-007-code-reader-agent.md` 和 `TASK-013-test-runner-agent.md` 内容已经明确是 Runtime Adapter。
   - 后续可低风险重命名为 `*-runtime-adapter.md`，并同步 README 链接。

2. **统一注册仍需在执行时确认**
   - TASK-002 负责 Runtime Registry。
   - TASK-004 负责 Tool Registry。
   - 执行 TASK-007/013 时，需要确认对应 provider 已在 Nest module 中注册。

3. **集成测试可在下一批任务补强**
   - 当前任务已有 smoke 建议。
   - 若进入实现阶段，建议新增一条端到端任务，覆盖 Runtime selection → Tool invocation → audit/result。

---

## TDD 执行口径

每个实现任务按下面顺序执行：

1. 先写单元测试或 smoke，明确当前失败点。
2. 再写最小实现，让测试通过。
3. 跑任务文档中的最小测试命令。
4. 跑 `npm run typecheck`。
5. 涉及权限、写文件、命令执行、路由降级时，补审计或 e2e smoke。

文档类任务不做代码 TDD，但必须做结构化校验：

```powershell
Get-ChildItem docs/tasks/TASK-*.md | Select-Object Name
Get-Content -Encoding utf8 docs/tasks/README.md
```

---

## 时间与排期

- 串行总时间：约 **250 分钟**
- 并行最短时间：约 **125 分钟**
- 单任务粒度：**15-30 分钟**
- 内部 Runtime 任务由于需要扩展 `RuntimeType`，预估为 30 分钟

推荐执行顺序：

1. TASK-001 + TASK-003
2. TASK-002 + TASK-004 + TASK-006
3. TASK-005 + TASK-010 + TASK-011 + TASK-012 + TASK-008
4. TASK-007
5. TASK-013
6. TASK-009

---

## 最终结论

任务拆分质量：通过。

是否可以开始执行：可以。

执行前只需要确认一件事：TASK-007/013 是否现在就作为正式 `RuntimeType` 暴露给产品配置。如果答案是“是”，按当前文档执行即可；如果答案是“否”，需要先把它们标记为仅供内部 Registry/Router 测试使用，并避免进入用户可配置 runtime 列表。
