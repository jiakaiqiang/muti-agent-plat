# M2-03 · claude-code-runtime-stub 假 CLI 升级

## 目标

升级现有 claude-code-runtime-stub 为**输出 stream-json 逐行事件**的假进程；发一次 control_request 验证平台应答；覆盖 result 帧带 session_id 与 usage。

## 依赖

M2-02。

## 前置阅读

- 现有 stub 位置（grep `claude-code-runtime-stub` 或 `CLAUDE_CODE_CLI_PATH`）
- M2-01/02 帧格式

## 测试步骤（红）

新增 `tests/e2e/fixtures/claude-stream-json-stub.spec.mjs`：

1. spawn stub → stdin 写 prompt → stdout 依序读到 ≥5 行事件（system/init → assistant/text → assistant/tool_use → 平台应答 control_response → user/tool_result → result）
2. result.session_id 非空、result.usage.input_tokens > 0

`node --test` → 红。

## 实现要点（绿）

新增 `tests/e2e/fixtures/claude-stream-json-stub.mjs`：
- 从 stdin 读一行 prompt JSON
- 按序 write 5+ 行事件，中间发一次 control_request 并等 stdin 收 control_response 再继续
- 中文 + 代码块 + 长文本覆盖

保留原 stub 供灰度 off 路径。

## 验收目标

- [ ] stub 脚本 + 单测
- [ ] 单测绿
- [ ] 旧 `claude-code-runtime-stub-smoke.mjs` 在灰度 off 下仍绿

## 时间估算

15 分钟。

## 提交信息

```
task(M2-03): claude stream-json stub CLI 升级
```
