# M1-12 · CodexAdapter 换成 spawn app-server

## 目标

`codex-runtime-adapter.service.ts` 内加**新执行核**（新方法 `runStreaming`），基于 M1-07/08 spawn `codex app-server`；本任务不改 `run()` 入口路由，只让 `runStreaming` 可被单测调用。

## 依赖

M1-11 已合并。

## 前置阅读

- 现有 `codex-runtime-adapter.service.ts` 结构
- Node `child_process.spawn`、`stdin/stdout` 流处理

## 测试步骤（红）

新建 `codex-runtime-adapter-streaming.spec.ts`：

1. Spawn 指向 M1-11 stub → `runStreaming(input)` 返回一个 `Promise<AgentRunResult>` + iterable
2. 断言 result.status = 'completed'、output.kind 匹配 expectedOutput
3. 断言过程中 push 到 `RunChannel` 的帧序列符合 M1-11 stub 的产帧
4. stub 崩溃（stub 支持环境变量 `STUB_CRASH=1` 触发退出码 1）→ result.status = 'failed'、error.code = 'MODEL_ERROR'

## 实现要点（绿）

- 新增 `private async runStreaming(input, signal): Promise<AgentRunResult>`
- 内部：spawn → 用 M1-07 codec 解 stdout → 用 M1-08 parser 变帧 → push 到 M1-03 RunChannel → 尾部用 M1-09/10 mapper 出 output
- signal.abort → kill 进程
- 不接看门狗（M1-13 才接）
- 保留原 `run()` 走 execFile 旧路径

## 验收目标

- [ ] 4 用例绿
- [ ] 旧 `run()` 路径未改，旧 e2e 仍绿（`codex-runtime-stub-smoke.mjs`）
- [ ] `typecheck` 通过

## 时间估算

15 分钟。

## 提交信息

```
task(M1-12): CodexAdapter 新增 runStreaming 方法（spawn app-server）
```

## 常见坑

- spawn 后一定要 `child.on('error')` 和 `on('exit')` 都监听，否则孤儿进程
- stdin 用 `child.stdin.write()` 后要 `.end()` 或保持 open——本项目保持 open（app-server 长驻）
