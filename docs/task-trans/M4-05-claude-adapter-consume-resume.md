# M4-05 · ClaudeAdapter 消费 `--resume`

## 目标

ClaudeAdapter runStreaming 时按 `options.resume.cliSessionId` 追加 `--resume <id>` flag；`workDir` 作为 spawn cwd。

## 依赖

M4-04。

## 前置阅读

- M2-04 ClaudeAdapter spawn 逻辑
- Claude CLI `--resume` 语义

## 测试步骤（红）

追加 `claude-code-runtime-adapter-streaming.spec.ts`：

1. 无 resume → args 不含 `--resume`
2. 有 resume → args 含 `--resume <id>`
3. workDir 生效为 spawn cwd

## 实现要点（绿）

- args 构造函数追加分支
- spawn 传 cwd

## 验收目标

- [ ] 3 用例绿
- [ ] `typecheck` 通过

## 时间估算

10 分钟。

## 提交信息

```
task(M4-05): ClaudeAdapter 消费 --resume
```
