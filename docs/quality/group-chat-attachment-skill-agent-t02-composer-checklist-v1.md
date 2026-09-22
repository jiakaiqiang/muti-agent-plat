# GC-02 输入框附件与 Tag 状态 Checklist v1

> [Spec](../product/group-chat-attachment-skill-agent-t02-composer-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t02-composer-plan-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t02-composer-task-v1.md)

## 自动验证

- [x] 组件测试可添加/删除图片和文件。
- [x] 第 5 张图片或第 5 个文件被拒绝并提示。
- [x] 第二个 Skill 选择被阻止，并支持显式替换。
- [x] 多个 Agent Tag 可以同时存在。
- [x] 未完成 `@` 选择不能发送，普通 `/` 文本可以发送。
- [x] 附件-only 草稿会发出结构化上下文，且不携带本地 `File`/预览字段。
- [x] 发送后草稿附件和 Tag 状态清空，停止/继续会话回归不受影响。

## UI 与可访问性验证

- [x] 图片缩略图和文件预览 Tag 可区分（组件渲染测试）。
- [x] `/` 和 `@` Tag 样式不同（固定 class、颜色、字重/字体样式）。
- [x] `/`、`@` 选择顺序不依赖（状态操作测试）。
- [x] 删除一个 Tag/附件不会清空其他草稿内容（独立删除测试）。
- [x] 输入框有原生 label，删除按钮有可访问名称，未完成 `@` 错误通过 `aria-describedby` 关联。

## 证据记录

| 项目 | 记录 |
| --- | --- |
| 执行日期 | 2026-09-22 |
| 命令 | `npm run typecheck -w @project/web`; `npm run typecheck -w @agent-cluster/desktop`; `npm run typecheck -w @agent-cluster/shared`; `npm run test -w @project/web`; `node --import tsx --test packages/shared/src/group-chat-contracts.spec.ts` |
| 结果 | Web 类型检查通过；Desktop/shared 类型检查通过；Web 全量 66/66 测试文件、339/339 测试通过；共享合同 7/7 通过 |
| 失败/跳过原因 | 首次从仓库根目录直接调用 Vitest 未加载 Vue 插件配置，未产生断言执行；改用 Web workspace 入口后通过。 |
