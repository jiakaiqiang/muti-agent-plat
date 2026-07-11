# M4-09 · adapter prompt 减重集成 TDD

> 状态：✅ 已完成（2026-07-10）  
> 实际实现：Codex/Claude legacy 与 streaming 路径均接入 Workdir Brief，prompt 只保留紧凑任务说明和 sidecar 引用。

## 目标

Codex/Claude adapter 在启用流式路径时：调用 `WorkdirBriefService` 落 brief → spawn 时 cwd 指向该目录 → prompt 只留任务本身（不再 `JSON.stringify(contextPack)`）。

## 依赖

M4-08。

## 前置阅读

- M1-12 CodexAdapter runStreaming
- M2-04 ClaudeAdapter runStreaming

## 测试步骤（红）

追加两个 adapter 的 streaming spec：

1. 启用流式 + 未提供 options.workDir → 调 `provisionWorkdir` + `writeBrief`
2. spawn cwd = workdir
3. prompt 字符串长度显著 < 之前（断言 `promptLen < baselineLen * 0.5`）
4. 任务结束 → `cleanupWorkdir` 被调（可用 spy 断言）
5. 提供了 options.workDir（M4-04/05 resume 场景）→ 复用不新建

## 实现要点（绿）

- adapter 内接入 WorkdirBriefService
- prompt 精简为：agent 角色 + 任务描述 + 期望输出 kind 的一行提示

## 验收目标

- [ ] 5 用例绿（每 adapter）
- [ ] `typecheck` 通过

## 时间估算

15 分钟。

## 提交信息

```
task(M4-09): adapter prompt 减重 + workdir brief 集成
```

## 常见坑

- prompt 减重后要保证 mock/generic_llm 路径**完全不受影响**（它们不用 workdir）
