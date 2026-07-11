# M4-04 · CodexAdapter 消费 resume 参数

## 目标

CodexAdapter 在 spawn app-server 时把 `options.resume.cliSessionId` 作为 thread resume 参数带上；`workDir` 作为 spawn cwd。仅 codex，claude 见 M4-05。

## 依赖

M4-03。

## 前置阅读

- Codex app-server 的 thread resume API（如 `thread.resume` 请求）
- M1-12 CodexAdapter spawn 逻辑

## 测试步骤（红）

追加 `codex-runtime-adapter-streaming.spec.ts`：

1. 无 resume → 走新 thread 流程
2. 有 resume.cliSessionId → 发送 `thread.resume` 请求携带 id
3. 有 resume.workDir → spawn 的 cwd 为该目录（用 mock 断言）

## 实现要点（绿）

- runStreaming 内判 options.resume 分支
- workDir 存在时 `spawn(cmd, args, {cwd: workDir})`

## 验收目标

- [ ] 3 用例绿
- [ ] `typecheck` 通过

## 时间估算

12 分钟。

## 提交信息

```
task(M4-04): CodexAdapter 消费 resume 参数
```
