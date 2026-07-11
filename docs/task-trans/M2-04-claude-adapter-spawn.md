# M2-04 · ClaudeAdapter 换成 spawn stream-json

## 目标

`claude-code-runtime-adapter.service.ts` 新增 `runStreaming` 方法，spawn `claude -p --output-format stream-json --input-format stream-json --verbose --strict-mcp-config --permission-mode bypassPermissions`；接入 M1 组件（RunChannel、Watchdog、Mapper）；旧 execFile 路径保留。

## 依赖

M2-03。

## 前置阅读

- 现有 `claude-code-runtime-adapter.service.ts:47` 一次性 execFile
- 上游设计 3.3

## 测试步骤（红）

新建 `claude-code-runtime-adapter-streaming.spec.ts`：

1. spawn 指向 M2-03 stub → `runStreaming` 返回 result.status = 'completed'
2. output.kind 匹配 expectedOutput
3. RunChannel push 序列符合 stub 产帧
4. stub 崩溃 → status = 'failed'、error.code = 'MODEL_ERROR'
5. stderr tail 收集到 `error.details.stderrTail`（≤ 8KB）
6. control_request 被平台应答（stub 端能读到 control_response 并继续）

## 实现要点（绿）

- 内部：spawn → stdin 独立 writer 队列 → stdout readline → M2-01 parser 变帧 → M1-03 channel → M1-09/10 mapper
- stderr 收有界环形 buffer（8KB）
- control_request 帧到达时用 M2-02 handler 生成 response，push 到 stdin writer 队列
- signal.abort → kill 进程

## 验收目标

- [ ] 6 用例绿
- [ ] 旧 `run()` execFile 路径未改
- [ ] `typecheck` 通过

## 时间估算

15 分钟。

## 提交信息

```
task(M2-04): ClaudeAdapter 新增 runStreaming（spawn stream-json）
```

## 常见坑

- stdin 必须保持 open 才能应答 control_request——不能 `.end()`
- stdin 写入必须**队列化**避免与后续应答竞态；即"独立异步任务"，同 multica claude.go 的做法
