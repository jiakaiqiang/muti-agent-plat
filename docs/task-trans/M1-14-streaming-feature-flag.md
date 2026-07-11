# M1-14 · 灰度开关 `ENGINEERING_RUNTIME_STREAMING`

## 目标

`common/runtime-config.ts` 新增 `engineeringRuntimeStreaming()` 读 `off | codex | all`，默认 `off`；`CodexAdapter.run()` 根据开关分流到旧 execFile 或 M1-12 的 `runStreaming`。

## 依赖

M1-13 已合并。

## 前置阅读

- `common/runtime-config.ts` 现有配置函数风格
- 上游设计第 3.8 节

## 测试步骤（红）

1. `runtime-config.spec.ts` 追加：
   - 未设 env → `'off'`
   - 设 `codex` → `'codex'`
   - 设 `all` → `'all'`
   - 设 `random` → `'off'`（unknown 回落）
2. `codex-runtime-adapter.service.spec.ts` 追加：
   - env=off → 调 `run` 时走旧 execFile 分支（用 mock 断言）
   - env=codex → 走 `runStreaming` 分支
   - env=all → 走 `runStreaming`

## 实现要点（绿）

- 加 `engineeringRuntimeStreaming` 函数
- adapter 的 `run` 首行判分支

## 验收目标

- [ ] 7 用例绿
- [ ] `typecheck` 通过
- [ ] 默认 off 下所有旧 e2e 绿

## 时间估算

12 分钟。

## 提交信息

```
task(M1-14): 灰度开关 ENGINEERING_RUNTIME_STREAMING
```
