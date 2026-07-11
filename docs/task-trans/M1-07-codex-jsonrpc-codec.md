# M1-07 · Codex JSON-RPC 2.0 编解码器 TDD

## 目标

新建 `codex-appserver-codec.ts`：将 Codex app-server stdio JSON-RPC 2.0 消息按 `Content-Length: N\r\n\r\n<json>` 帧格式**编码/解码**（同 LSP 协议）。仅编解码，不管进程。

## 依赖

M1-06 已合并。

## 前置阅读

- Codex app-server 协议采用 LSP 风格 headers
- 上游设计 3.4

## 测试步骤（红）

新建 `codex-appserver-codec.spec.ts`：

1. **encode**：`encode({jsonrpc:'2.0',id:1,method:'ping'})` 返回 `Content-Length: 27\r\n\r\n{"jsonrpc":"2.0","id":1,"method":"ping"}` 结构（Buffer）
2. **decode 单帧**：喂完整字节流一次 → 拿到 1 条解码消息
3. **decode 分片**：拆两次喂 → 拼齐后拿到 1 条
4. **decode 粘包**：一次喂两帧 → 拿到 2 条
5. **UTF-8 长度**：中文 payload 的 Content-Length 按字节数不是字符数

## 实现要点（绿）

- `encode(msg): Buffer` = header + json bytes
- `Decoder` 类维护内部 buffer；`feed(chunk: Buffer): JsonRpcMessage[]` 返回本次完整解出的消息
- 状态机：READ_HEADER → READ_BODY（拿到 Content-Length 后）→ 回 READ_HEADER

## 验收目标

- [ ] `codex-appserver-codec.ts` + `.spec.ts`
- [ ] 5 用例全绿
- [ ] `typecheck` 通过

## 时间估算

15 分钟。

## 提交信息

```
task(M1-07): Codex app-server JSON-RPC 编解码器 TDD
```

## 常见坑

- Content-Length 是**字节数**不是字符数，中文用例必须覆盖
- header 大小写不敏感？先按 LSP 规范用固定大小写实现，测试也固定
