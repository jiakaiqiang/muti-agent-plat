# M4-01 · `RuntimeInvocationLog` 加 `cliSessionId/workDir`

## 目标

`apps/server/src/modules/runtimes/runtime.service.ts` 的 `RuntimeInvocationLog` 类型加两个可选字段；写入时从 result 帧取值（M1-08 已解析出 `cliSessionId`）。

## 依赖

M3-07。

## 前置阅读

- `runtime.service.ts:13-28` `RuntimeInvocationLog`
- M1-08 `result` 帧 `cliSessionId`

## 测试步骤（红）

`runtime.service.spec.ts` 追加：

1. 假 adapter 返回带 `cliSessionId='s1'` 的 result → invocation log 记录 `cliSessionId='s1'`
2. 未返回 cliSessionId → 字段 undefined
3. workDir 从 input.options 或 adapter 返回获取

## 实现要点（绿）

- 类型加两字段
- `RuntimeService.run` 从 result / options 中取值写入 log
- JSONB collection 自动持久化

## 验收目标

- [ ] 3 用例绿
- [ ] `typecheck` 通过

## 时间估算

10 分钟。

## 提交信息

```
task(M4-01): RuntimeInvocationLog 加 cliSessionId/workDir 字段
```
