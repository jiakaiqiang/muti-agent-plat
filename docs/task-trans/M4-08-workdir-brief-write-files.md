# M4-08 · brief 写入 CLAUDE.md / AGENTS.md TDD

> 状态：✅ 已完成（2026-07-10）  
> 实际实现：运行期间原子注入目标文件，结束或启动恢复时逐字节还原，原文件不存在时删除临时文件。

## 目标

`WorkdirBriefService.writeBrief(workdir, contextPack)` 把 ContextPack 稳定部分写成两个文件：`<workdir>/CLAUDE.md`（Claude 读）和 `<workdir>/AGENTS.md`（Codex 读）；任务上下文写 `.agent_context/` sidecar。

## 依赖

M4-07。

## 前置阅读

- ContextPack 类型
- multica 的 `InjectRuntimeConfig` 思路

## 测试步骤（红）

追加 spec：

1. 写 brief → 两个 md 存在且内容含 `agent.instructions` / `constraints` / `skills`
2. `.agent_context/task-brief.json` 存在，含 `taskId/goal/acceptanceCriteria`
3. 已存在同名文件（罕见）→ 追加时间戳后缀备份（不覆盖）
4. 幂等：连调 2 次不叠加内容

## 实现要点（绿）

- brief 由稳定字段（instructions/constraints/skills/systemRules）拼装
- taskContext（可变）单独进 sidecar
- 用 `writeFile` + 校验目录在临时区

## 验收目标

- [ ] 4 用例绿
- [ ] `typecheck` 通过

## 时间估算

15 分钟。

## 提交信息

```
task(M4-08): WorkdirBriefService.writeBrief 落盘 CLAUDE.md/AGENTS.md
```
