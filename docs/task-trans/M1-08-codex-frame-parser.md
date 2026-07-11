# M1-08 · Codex 事件 → `RuntimeStreamFrame` 解析器 TDD

## 目标

新建 `codex-frame-parser.ts`：把 Codex app-server 的 JSON-RPC **notification 事件**（如 `agent.text_delta` / `tool.called` / `run.completed`）翻译成内部 `RuntimeStreamFrame`。

## 依赖

M1-07 已合并（拿到 JsonRpcMessage 才能翻译）。

## 前置阅读

- M1-02 的 `RuntimeStreamFrame` 6 种 kind
- Codex app-server notification schema（如项目未镜像，先按下列示例约定，落 e2e 时再对齐）

## 测试步骤（红）

新建 `codex-frame-parser.spec.ts`。约定示例（如实际不符，M1-11 的 stub 里对齐）：

- `{method:'agent.text_delta', params:{text:'你好'}}` → `{kind:'assistant_text', text:'你好'}`
- `{method:'tool.called', params:{id:'t1', name:'read_file', input:{path:'x.ts'}}}` → `{kind:'tool_use', toolCallId:'t1', tool:'read_file', input:{path:'x.ts'}}`
- `{method:'tool.completed', params:{id:'t1', name:'read_file', output:'...'}}` → `{kind:'tool_result', toolCallId:'t1', tool:'read_file', output:'...'}`
- `{method:'run.completed', params:{payload:..., usage:{...}, sessionId:'s1'}}` → `{kind:'result', payload, usage, cliSessionId:'s1'}`
- 未知 method → `{kind:'system', subtype:method, raw}`

## 实现要点（绿）

纯函数 `parseCodexNotification(msg: JsonRpcNotification): RuntimeStreamFrame`。用 switch。字段缺失时用类型保护 + 兜底到 `system`。

## 验收目标

- [ ] `codex-frame-parser.ts` + `.spec.ts`
- [ ] 5 用例全绿
- [ ] `typecheck` 通过

## 时间估算

12 分钟。

## 提交信息

```
task(M1-08): Codex 事件 → RuntimeStreamFrame 解析 TDD
```

## 常见坑

- notification 与 response 别混——response 有 `id`，notification 无
- 不认识的 method 一律走 `system`，别抛错（forward 兼容）
