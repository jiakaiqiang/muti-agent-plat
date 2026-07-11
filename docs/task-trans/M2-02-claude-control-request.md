# M2-02 · Claude `control_request` 双向帧 TDD

## 目标

处理 Claude CLI 的 `control_request` 帧——CLI 会主动询问平台（比如权限确认），平台需通过 stdin 应答 `control_response`。本任务实现 request → response 的策略层与协议编解码。

## 依赖

M2-01。

## 前置阅读

- Claude Code CLI 的 control_request/response schema
- 上游设计 3.3 第 1 点（stdin/stdout 独立协程）

## 测试步骤（红）

新建 `claude-control-request.spec.ts`：

1. `{type:'control_request',request_id:'r1',request:{subtype:'can_use_tool',...}}` → 策略层默认返回 `{allow:true}`（因为我们已经用 `--permission-mode bypassPermissions`；仍要能应答）
2. 编码 `control_response` 为符合 CLI 期望的 JSON line
3. 未知 subtype → 默认 deny + `warning` 日志

## 实现要点（绿）

- `ControlRequestHandler` 类：`handle(req): controlResponsePayload`
- 编码为 `JSON.stringify({type:'control_response',request_id,response}) + '\n'`

## 验收目标

- [ ] 3 用例绿
- [ ] `typecheck` 通过

## 时间估算

10 分钟。

## 提交信息

```
task(M2-02): Claude control_request 双向帧 TDD
```
