# Claude Buffered 非零退出结果恢复方案 v1

## 问题

Claude Code buffered 模式可能已经输出符合 Runtime 合同的 JSON，但随后因为 CLI 自动更新失败、清理失败或其他退出阶段问题返回非零退出码。

旧逻辑只检查进程退出码。只要 `execFile` 返回错误，就丢弃 stdout，并报告：

```text
Claude Code could not be started or exited before producing a result.
```

这会把“模型已经成功生成结果，CLI 收尾阶段失败”错误地处理成整个 Agent 阶段失败。

## 已确认案例

Invocation：

```text
8137e7c6-f134-447c-9b74-046f39cc9f12
```

Claude Code 已生成并记录合法的 `agent_message`，随后以 `exitCode=1` 退出。同一时间 Claude 自动更新记录为：

```text
update_apply_exe_locked
```

## 修复规则

Buffered CLI 非零退出后：

1. 若调用被取消或超时，保持原终止语义。
2. 若 stdout 非空，按当前 `expectedOutput.kind` 解析并执行严格 Runtime 合同校验。
3. 合同校验通过：
   - Invocation 按 `completed` 返回；
   - 保留 Artifact 和平台捕获的文件变化；
   - 写入 `CLAUDE_NONZERO_EXIT_WITH_VALID_OUTPUT` 警告；
   - 保存 stderr 尾部和退出码用于诊断。
4. stdout 为空、无法解析或合同校验失败时，保持失败。

## 安全边界

- 不接受普通文本或宽松 JSON。
- 不绕过 Runtime output schema。
- 不把超时或用户取消恢复成成功。
- stdout 与预期合同不匹配时仍然 fail closed。

## 验证

回归测试覆盖：

```text
有效 agent_message stdout + exitCode=1
→ completed
→ 输出不丢失
→ stderr 和退出警告可追踪
```

## 实现状态

状态：已实现（2026-07-16）。

实现位置：

- `apps/server/src/modules/runtimes/claude-code-runtime-adapter.service.ts`
  - buffered `execFile` 错误会保留 stdout、stderr 和数字型退出码；
  - 仅在未取消、未超时、退出码为明确非零数字且 stdout 非空时尝试恢复；
  - 恢复复用 `parseClaudeBufferedOutputWithRuntimeError`，按 `expectedOutput.kind` 执行共享 Runtime 严格合同校验；
  - 合法输出返回 `completed`，保留模型 Artifact 和平台文件快照证据；
  - `runtime_completed` 记录 `CLAUDE_NONZERO_EXIT_WITH_VALID_OUTPUT` 与 `exitCode`，`runtimeDiagnostics.stderrTail` 保留最多 16 KiB stderr 尾部。
- `apps/server/src/modules/runtimes/claude-code-runtime-adapter.service.spec.ts`
  - 覆盖合法 `task_execution_result`、Artifact、实际文件变化、warning、exitCode 与 stderr；
  - 覆盖取消、超时、空 stdout、不可解析 stdout、错误 output kind 和非退出型进程错误继续 fail closed。

验证结果：

```text
node node_modules/tsx/dist/cli.mjs --test apps/server/src/modules/runtimes/claude-code-runtime-adapter.service.spec.ts
→ 33 passed, 0 failed

npm run typecheck -w @agent-cluster/server
→ passed
```

本次未调用真实 Claude Code CLI；已确认案例仍作为生产诊断依据，自动化验证使用确定性的 adapter 回归测试。

## 与 Provider 524 的边界

本方案只恢复“stdout 已包含合法 Runtime 输出、但进程随后非零退出”的结果。若 stdout/stderr 中包含 `API Error: 524` 等 Provider 响应，说明模型结果尚未生成，禁止按非零退出恢复为成功。Adapter 应将其分类为可重试的 `RUNTIME_TIMEOUT`，由 Orchestrator 执行一次同 Runtime 重试、circuit breaker 和 Session allowlist 内的备用 Runtime fallback；网关侧同时按 `docs/devops/local-development.md` 的长请求配置治理根因。
