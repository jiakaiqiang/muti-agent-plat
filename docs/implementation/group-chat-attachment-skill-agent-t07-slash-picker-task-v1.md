# GC-07 `/Skill` 分类选择器 Task v1

> 状态：已完成（实现、测试和证据已闭环）

> [Spec](../product/group-chat-attachment-skill-agent-t07-slash-picker-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t07-slash-picker-plan-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t07-slash-picker-checklist-v1.md)

## 任务目标

把 Skill 注册中心的数据接入输入框，完成一个可选择、可删除、可替换的 `/Skill` Tag。

## 10–15 分钟执行清单

1. 从 Skill store 获取已启用、当前用户可用的分类列表。
2. 在 `UserInputBox.vue` 接入 `/` 触发和关闭逻辑。
3. 渲染一级分类和按名称排序的 Skill。
4. 选择后写入单一 SkillRef，第二次选择给出限制提示。
5. 增加删除、替换、Esc 和普通 `/` 文本测试。

## 完成定义

用户可以从 `/` 列表选择一个 Skill，发送时获得稳定引用，不会把普通路径文本误识别为 Skill。

## 交付记录

- `UserInputBox.vue` 接入单 `/` 触发、关闭、Esc、上下键和回车选择；正文路径不会自动变成 Skill。
- `skill.ts` 增加 `/skills/categories/available`，选择器消费服务端过滤后的可用 Skill 与分类。
- 选择器按分类名称、Skill 名称排序，不提供搜索框；已禁用或无权限项不展示。
- 选择结果写入一个包含 `id`、`key`、`revision`、作用域与分类的 `GroupChatSkillRef`，既有 Tag 删除/替换能力保持不变。
- 新增 3 个选择器行为用例，覆盖分类排序、键盘/Esc、普通斜杠文本和第二个 Skill 限制。

## 验证结果

- `npm run typecheck -w @project/web`：通过。
- `npm run test -w @project/web -- src/components/UserInputBoxComposer.spec.ts`：13/13 通过。
- `npm run test -w @project/web`：66 个文件、344 个测试通过。
- 首次无权限运行 Vitest 时出现 `spawn EPERM`，按环境约束以允许子进程的同一命令重跑并通过；无代码失败遗留。
