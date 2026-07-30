# 异常停止问题分析报告

**分析时间**: 2026-07-24  
**分析范围**: agent-cluster 前后端系统异常停止行为  
**基线版本**: f204646 (v2 runtime + relational persistence)

## 执行摘要

系统存在三类"异常停止"场景，根因、影响面和修复状态各不相同：

1. **会话删除超时（已知问题）**: 后端 grace period 机制正常工作，前端用户体验可优化
2. **执行阶段卡死（已修复）**: Phase timeout 缺失导致永久冻结，已在 2026-07-20 修复
3. **讨论阶段孤儿化（已修复）**: 服务重启导致 AGENT_DISCUSSING 永久冻结，已在 2026-07-02 修复

## 问题1：会话删除时的"未能停止"异常

### 现象
前端删除会话时，后端可能抛出 `ConflictException`:
```
Session runtime did not stop within the deletion grace period: ${sessionId}
```

### 根因分析

**这不是 bug，是设计的安全机制**。

后端删除会话时需要终止三类后台任务：
- Brief generation (契约生成)
- Execution queue (执行队列)
- Runtime invocation (运行时调用)

```typescript
// apps/server/src/modules/sessions/sessions.service.ts:252-261
const briefStopped = briefRun ? await settlesWithin(briefRun.done, 10_000) : true;
const [executionStopped, runtimeStopped] = await Promise.all([
  executionCancellation,
  runtimeCancellation,
  workflowCancellation
]);
if (!briefStopped || executionStopped.timedOut || runtimeStopped.timedOut) {
  throw new ConflictException(
    `Session runtime did not stop within the deletion grace period: ${sessionId}`
  );
}
```

**Grace period 时长**：
- Brief generation: 10 秒（`settlesWithin(briefRun.done, 10_000)`）
- Execution/Runtime: 由 `cancelAndWait` 内部控制（通常 5-10 秒）

**触发条件**：
1. Runtime 正在执行长时间 LLM 调用（如本地 7B 模型 prefill 需 1-2 分钟）
2. Execution queue 中有挂起的任务未能响应 abort signal
3. Brief generation 正在等待 LLM 返回契约 JSON

### 影响评估

**用户体验**：
- ❌ 删除按钮点击后无反馈，10 秒后弹出错误提示
- ❌ 会话仍保留在列表中（删除失败）
- ✅ 数据一致性保护：避免删除进行中的会话导致资源泄漏

**安全性**：
- ✅ 防止删除正在执行的会话（可能导致 worktree 泄漏、Runtime 孤儿进程）
- ✅ 确保所有后台任务完全停止后再清理状态

### 解决方案

**P0 - 前端 UX 改进**（推荐）：
```typescript
// apps/web/src/components/SessionWorkspace.vue
async function deleteSession(sessionId: string) {
  if (deletingSessionIds.value.includes(sessionId)) return
  
  // 新增：立即显示"正在停止执行..."提示
  showMessage(`正在停止会话 ${sessionId} 的运行中任务...`, 'info')
  
  const deletingCurrent = sessionStore.currentSession?.id === sessionId
  try {
    const deleted = await sessionStore.deleteSession(sessionId)
    if (!deleted) {
      showMessage('删除失败：会话运行中任务未能在 10 秒内停止，请稍后重试。', 'warning')
      return
    }
    // 现有成功逻辑...
  } catch (error) {
    // 现有错误处理...
  }
}
```

**P1 - 后端 grace period 延长**（可选）：
```typescript
// apps/server/src/modules/sessions/sessions.service.ts
// 延长 brief generation 等待时间（当前 10s → 30s）
const briefStopped = briefRun ? await settlesWithin(briefRun.done, 30_000) : true;
```

**P2 - 强制删除选项**（不推荐，安全风险）：
- 提供 `force: true` 参数跳过 grace period
- 仅用于开发环境调试

## 问题2：执行阶段永久卡死（已修复 2026-07-20）

### 现象
前端工程师报告：发出 `runtime_started` 后永久停在"运行中"，workflow node 一直 running。

### 根因
**执行阶段三层超时全缺**：
1. `PHASE_TIMEOUT_TASK_EXECUTION_MS` 未配置 → `phaseTimeoutMs('task_execution')` 返回 0
2. `phaseController`/`phaseTimer` 根本不创建（因为 timeoutMs=0）
3. `await execution.result` 永不 resolve → workflow 永不推进

```typescript
// apps/server/src/modules/orchestrator/orchestrator.service.ts:5010-5045
const timeoutMs = phaseTimeoutMs(plan.phase);
const phaseController = timeoutMs > 0 ? new AbortController() : undefined; // ❌ timeoutMs=0 不创建
const phaseTimer = phaseController
  ? setTimeout(() => {
      abortWithTermination(phaseController, /* phase_timeout */)
    }, timeoutMs)
  : undefined; // ❌ 无 timer = 永不超时
```

### 修复状态
**已在 2026-07-20 修复**（见 memory `agent-freeze-root-cause-2026-07.md:39-49`）：
- `.env.example`: `PHASE_TIMEOUT_TASK_EXECUTION_MS=600000` (10分钟兜底)
- `worktree-execution/git-command.ts`: `runGit` 加超时（默认 120s）
- `runtimes/runtime.service.ts`: `startInBrowserMirror` 的 `prepare` 加超时（默认 300s）

### 验证
```bash
npm run typecheck  # ✅ 通过
npm run test       # ✅ 27 worktree/runtime 测试通过
```

## 问题3：讨论阶段孤儿化（已修复 2026-07-02）

### 现象
前端时间线停在「上下文已裁剪至 focused 阶段」后永久无响应。

### 根因
**重启孤儿化** + **本地模型超长窗口期**：
1. 契约生成是纯内存 fire-and-forget promise（`generateBriefInBackground`）
2. `recovery.service.ts` 的 `RESUMABLE_STATUSES` 不含 `AGENT_DISCUSSING`
3. 服务重启后讨论期会话被静默跳过，永远冻结

### 修复状态
**已在 2026-07-02 修复**（见 memory `agent-freeze-root-cause-2026-07.md:30-37`）：
- P0: `recovery.service.ts` 启动时对 `AGENT_DISCUSSING` 会话调用 `resumeBriefGeneration()`
- P1a: `orchestrator.runRuntime` 每 30s 发心跳事件（`RUNTIME_HEARTBEAT`）
- P1b: `.env` 收紧超时配置（LLM_TIMEOUT_MS=180s, DISCUSSION_TIMEOUT_MS=60s）

## 配置推荐

### 当前 .env.example 配置
```bash
# Phase timeouts
PHASE_TIMEOUT_DISCUSSION_MS=0                    # ✅ 讨论阶段无硬超时（依赖 LLM_TIMEOUT_MS）
PHASE_TIMEOUT_TASK_EXECUTION_MS=600000           # ✅ 执行阶段 10 分钟兜底
# PHASE_TIMEOUT_BRIEF_GENERATION_MS=0            # 其他阶段默认 0（无限）
# PHASE_TIMEOUT_POST_REVIEW_MS=0
```

### 生产环境建议
```bash
# 防御性超时配置
PHASE_TIMEOUT_TASK_EXECUTION_MS=600000           # 执行阶段 10 分钟
PHASE_TIMEOUT_BRIEF_GENERATION_MS=300000         # 契约生成 5 分钟
PHASE_TIMEOUT_POST_REVIEW_MS=180000              # 复盘 3 分钟
LLM_TIMEOUT_MS=180000                            # LLM 单次调用 3 分钟
```

## 监控建议

### 后端日志关键词
```typescript
// 会话删除超时
"Session runtime did not stop within the deletion grace period"

// Phase timeout 触发
"phase_timeout" + "orchestrator" + "scope: 'phase'"

// Recovery 恢复失败
"recovery" + "AGENT_DISCUSSING"
```

### 前端用户反馈模式
- "删除会话没反应" → 大概率 grace period 超时
- "一直显示运行中" + workflow node 卡住 → 检查 `PHASE_TIMEOUT_TASK_EXECUTION_MS`
- "讨论后无响应" + 重启过服务 → 检查 recovery 日志

## 结论

### 当前状态
| 问题 | 状态 | 优先级 | 建议行动 |
|------|------|--------|---------|
| 会话删除超时异常 | 设计行为，可优化 UX | P1 | 前端加删除进度提示 |
| 执行阶段永久卡死 | ✅ 已修复 (2026-07-20) | - | 无需行动 |
| 讨论阶段孤儿化 | ✅ 已修复 (2026-07-02) | - | 无需行动 |

### 下一步行动
1. **前端 UX 改进**（1-2 小时工作量）：
   - `SessionWorkspace.vue` 删除会话时加"正在停止..."提示
   - 显示 grace period 倒计时（可选）

2. **配置检查**：
   - 确认生产环境 `.env` 包含 `PHASE_TIMEOUT_TASK_EXECUTION_MS=600000`
   - 确认 `D:\code\PROJECT` 副本的 .env 已同步（memory 提到的启动脚本路径）

3. **监控补齐**：
   - 后端日志中统计 `ConflictException` 的 "grace period" 发生率
   - 前端埋点：删除操作的成功率、失败原因分布

---

**相关文档**:
- `C:\Users\kaiqj\.claude\projects\D--demo-muti-agent-muti-agent-plat\memory\agent-freeze-root-cause-2026-07.md`
- `apps/server/src/modules/sessions/sessions.service.ts:223-279`
- `apps/server/src/modules/orchestrator/orchestrator.service.ts:5010-5092`
- `apps/server/src/common/execution-termination.ts`
