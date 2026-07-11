# M1-11 · 升级 codex-runtime-stub 假 CLI 可产帧

## 目标

将现有 `tests/e2e/codex-runtime-stub-smoke.mjs` 使用的 stub CLI 升级为**能按 JSON-RPC 2.0 输出 notification 帧**的假进程；本任务只升级 stub 与关联单测，不改 adapter。

## 依赖

M1-10 已合并。

## 前置阅读

- 现有 stub 路径（grep `codex-runtime-stub` 或 `CODEX_CLI_PATH`）
- M1-07 的 JSON-RPC 帧格式约定
- M1-08 的 notification method 约定

## 测试步骤（红）

1. Grep 定位 stub：`grep -rn "codex.*stub\|stub.*codex" tests/e2e/ apps/server/` 
2. 现有 stub 可能是一次性输出 JSON 的 shell/JS，写一个 spec：
   - `tests/e2e/fixtures/codex-appserver-stub.spec.mjs`（新增）
   - 启动 stub → 用 M1-07 codec 解出 ≥3 条 notification：`agent.text_delta` → `tool.called` → `tool.completed` → `run.completed`
3. `node --test tests/e2e/fixtures/codex-appserver-stub.spec.mjs` → **红**

## 实现要点（绿）

- 新增 `tests/e2e/fixtures/codex-appserver-stub.mjs`：Node 脚本，从 stdin 读 `initialize`/`run` 请求，按序 write 5 条 notification（含中文 + 代码块），然后 exit 0
- 老的一次性 JSON stub **保留**，用于灰度 `off` 路径回归

## 验收目标

- [ ] 新 stub 脚本 + 单测
- [ ] `node --test tests/e2e/fixtures/codex-appserver-stub.spec.mjs` 绿
- [ ] 旧 `codex-runtime-stub-smoke.mjs` 在灰度 off 下仍绿

## 时间估算

15 分钟。

## 提交信息

```
task(M1-11): codex-appserver stub CLI 升级为可产协议帧
```
