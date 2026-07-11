# M2-06 · 灰度扩至 `all` + M2 回归

> 状态：✅ 已完成（2026-07-10）  
> 结论：Claude stream-json 与 `ENGINEERING_RUNTIME_STREAMING=all` 受控 e2e 通过。

## 目标

将 `ENGINEERING_RUNTIME_STREAMING` 语义补齐 `all`（codex + claude 都走流式）；跑 M1/M2 全量回归。

## 依赖

M2-05。

## 前置阅读

- M1-14 灰度开关
- 上游设计 3.8

## 测试步骤（红）

1. 追加 `runtime-config.spec.ts` 用例：`all` → 返回 `'all'`
2. 追加 `claude-code-runtime-adapter.service.spec.ts`：
   - env=off → 旧 execFile
   - env=codex → 旧 execFile（不启用 claude 流式）
   - env=all → runStreaming
3. 新建 `tests/e2e/claude-streaming-smoke.mjs`：env=all + M2-03 stub，断言真事件 + tool_called + tokens>0

## 实现要点（绿）

- ClaudeAdapter.run 首行判：`env === 'all'` → runStreaming；否则 execFile

## 验收命令

```bash
npm run typecheck
npm run test
npm run test:harness
npm run build
node --test tests/e2e/codex-runtime-stub-smoke.mjs                                  # off 回归
node --test tests/e2e/claude-code-runtime-stub-smoke.mjs                           # off 回归
ENGINEERING_RUNTIME_STREAMING=codex node --test tests/e2e/codex-streaming-smoke.mjs
ENGINEERING_RUNTIME_STREAMING=all   node --test tests/e2e/codex-streaming-smoke.mjs
ENGINEERING_RUNTIME_STREAMING=all   node --test tests/e2e/claude-streaming-smoke.mjs
```

## 验收目标

- [ ] 所有命令绿
- [ ] `docs/analysis/feature-inventory-and-status-v1.md` R1/R2 状态更新
- [ ] `docs/contracts/runtime-contract-v0.1.md` 加变更日志条目

## 时间估算

15 分钟。

## 提交信息

```
task(M2-06): 灰度扩至 all + M2 全量回归
```
