# GC-10 协同任务面板与阶段输出 Checklist v1

> [Spec](../product/group-chat-attachment-skill-agent-t10-collaboration-panel-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t10-collaboration-panel-plan-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t10-collaboration-panel-task-v1.md)

## 自动验证

- [x] 路由事件创建协同任务面板。
- [x] 多个 Agent 状态能独立更新。
- [x] 重复/乱序事件不会重复或回退状态。
- [x] 中间输出能展开并保留历史。
- [x] 失败、取消和完成状态视觉可区分。

## 手工验证

- [x] 面板能展示 Agent、Skill 和附件处理关系。
- [x] 刷新页面后面板仍可展开。
- [x] 主 Agent 汇总不被阶段输出覆盖。

## 证据记录

| 项目 | 记录 |
| --- | --- |
| 执行日期 | 2026-09-22 |
| 命令 | `npm run typecheck -w @project/web`; `npm run test -w @project/web` |
| 结果 | Web typecheck 通过；Web 全量 67 文件、349 测试通过；协同模型 3/3 |
| 失败/跳过原因 | 无 |
