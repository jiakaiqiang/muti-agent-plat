# M1-17 · M1 e2e 全量回归

> 状态：✅ 已完成（2026-07-10）  
> 结论：Codex streaming、watchdog、RunHandle 和 legacy/off 回归通过。

## 目标

以 `ENGINEERING_RUNTIME_STREAMING=off` 跑全量 e2e（回归），再以 `ENGINEERING_RUNTIME_STREAMING=codex` 跑新流式 e2e。补一条集成 e2e。

## 依赖

M1-16 已合并。

## 前置阅读

- `tests/e2e/` 现有脚本清单

## 测试步骤（红）

1. 新建 `tests/e2e/codex-streaming-smoke.mjs`：
   - env=codex，指向 M1-11 stub
   - 跑 discussion 阶段任务
   - 断言：`assert(events.some(e => e.type === 'runtime_progress' && !e.metadata?.code?.startsWith('RUNTIME_HEARTBEAT')))`
   - 断言：`assert(events.some(e => e.type === 'tool_called'))`
   - 断言：`assert(events.some(e => e.type === 'runtime_completed'))`
   - 断言：`result.status === 'completed'`
   - 断言：`usage.totalTokens > 0`
2. 首次执行必然红（若之前局部测未打通）

## 实现要点（绿）

- 排查失败点回填必要修补
- 每处修补都要有对应的单测覆盖（回到相关 M1-XX 补测），别只在 e2e 里救火

## 验收命令（全绿才算完成 M1）

```bash
npm run typecheck
npm run test
npm run test:harness
npm run build
node --test tests/e2e/codex-runtime-stub-smoke.mjs            # 灰度 off，回归
ENGINEERING_RUNTIME_STREAMING=codex node --test tests/e2e/codex-streaming-smoke.mjs  # 新路径
```

## 验收目标

- [ ] 新 e2e 全绿
- [ ] 上述所有命令全绿
- [ ] `docs/analysis/feature-inventory-and-status-v1.md` 更新 R1 状态为"M1 已交付"

## 时间估算

15 分钟（若无遗留问题）；有问题回上一任务补。

## 提交信息

```
task(M1-17): M1 全量回归 + codex-streaming e2e
```

## M1 完成标准（对齐上游设计第 3.10 节）

- stub e2e 长中文 + 代码块 + 裸换行 → 无 `OUTPUT_SCHEMA_INVALID`
- ≥3 条真实 runtime_progress/tool_called 事件
- `usage.totalTokens > 0`
- `ENGINEERING_RUNTIME_STREAMING=off` 时行为与现状一致
- 用户 cancel 中途 abort → 进程被杀，`status: 'cancelled'`
