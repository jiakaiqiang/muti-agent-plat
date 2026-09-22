# GC-07 `/Skill` 分类选择器 Checklist v1

> [Spec](../product/group-chat-attachment-skill-agent-t07-slash-picker-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t07-slash-picker-plan-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t07-slash-picker-task-v1.md)

## 自动验证

- [x] `/` 可以打开 Skill 分类列表。
- [x] 列表只展示有权限且启用的 Skill（列表来自 `/skills/available`，组件过滤 `active`）。
- [x] 分类和 Skill 按名称排序。
- [x] 列表没有关键词搜索入口。
- [x] 选择后只有一个 SkillRef，并保留稳定 ID、key 和 revision。
- [x] 删除/替换 Skill Tag 正常（既有组件回归用例通过）。

## 手工验证

- [x] 普通 `/path` 文本不选择 Skill 时可以发送。
- [x] Esc 关闭列表不会丢失正文。
- [x] 选择 Skill 后 Tag 颜色和字体与 `@Agent` 不同（既有视觉/无障碍断言通过）。

## 证据记录

| 项目 | 记录 |
| --- | --- |
| 执行日期 | 2026-09-22 |
| 命令 | `npm run typecheck -w @project/web`; `npm run test -w @project/web -- src/components/UserInputBoxComposer.spec.ts`; `npm run test -w @project/web` |
| 结果 | 类型检查通过；定向 13/13；全量 66 文件、344 测试通过 |
| 失败/跳过原因 | 首次 Vitest 受环境 `spawn EPERM` 拦截，使用允许子进程的同一命令重跑通过；无代码失败遗留 |
