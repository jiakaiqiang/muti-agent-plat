# 工作流管理与运行时 V1 实施验收

日期：2026-07-14

## 范围映射

| 需求 | 实现位置 | 自动验证 |
| --- | --- | --- |
| 工作流列表、搜索、状态和相关 Agent | `apps/web/src/components/WorkflowManager.vue` | `WorkflowManager.spec.ts` |
| 三栏低代码创建器 | `WorkflowResourcePanel.vue`、`WorkflowCanvas.vue`、`WorkflowNodeInspector.vue` | Web build、组件测试 |
| Agent / 人工确认 / 机器人确认分组 | `WorkflowResourcePanel.vue` | `WorkflowManager.spec.ts` |
| 草稿、乐观锁、发布版本和归档 | `apps/server/src/modules/workflows/workflows.service.ts` | `workflows.service.spec.ts` |
| 群聊选择所有已发布工作流且不默认选中 | `WorkflowSelectionDialog.vue`、`ConfirmationCard.vue` | `ConfirmationCard.spec.ts` |
| Agent 自动推进、显式人工确认 | `workflow-runtime.service.ts` | `workflow-runtime.service.spec.ts` |
| 机器人结构化评审、返工和转人工 | `workflow-runtime.service.ts` | `workflow-runtime.service.spec.ts` |
| 精确版本快照与会话投影 | `sessions.service.ts`、共享合同 | `workflow-session-flow.spec.ts` |
| 本地/BullMQ 执行一致性 | `execution.service.ts`、`execution.worker.ts` | 服务端类型检查与单元回归 |
| 运行恢复、幂等事件与 effect | `recovery.service.ts`、`workflow-runtime.service.ts` | Recovery 与 Runtime 单测 |

## 验收边界

- V1 仅支持单开始、单结束的线性流程。
- 条件、并行、汇聚、循环、子流程、多用户会签和超时升级不在本次范围。
- 人工确认人固定为会话发起人。
- 机器人确认默认最多返工 2 次，格式无效、执行异常或超限后转人工。
- 正在运行的实例绑定不可变版本快照，不读取后续草稿变更。

## 验证命令

```bash
npm run build -w @agent-cluster/shared
npm run typecheck -w @agent-cluster/server
npm run test -w @project/web
npm run build -w @project/web
node node_modules/tsx/dist/cli.mjs --test apps/server/src/modules/workflows/workflows.service.spec.ts apps/server/src/modules/workflows/workflow-runtime.service.spec.ts apps/server/src/modules/sessions/workflow-session-flow.spec.ts apps/server/src/modules/recovery/recovery.service.spec.ts
```

## 浏览器验收

使用 Playwright 在隔离 V2 数据文件上完成真实页面验收：

- 桌面视口 `1600x1000`：三栏宽度稳定，画布点阵背景可见，3/3 个节点有非零尺寸，页面无横向溢出。
- 移动视口 `390x844`：顶部操作与元数据输入无重叠；编辑区保留内部横向滚动，不挤压节点和属性表单。
- 真实保存草稿返回 HTTP 201，保存后列表正确显示 Agent、人工确认、机器人确认数量。
- 浏览器 `console`、`pageerror` 和失败请求均为 0。

证据：

- `output/playwright/workflow-management-editor-desktop.png`
- `output/playwright/workflow-management-populated-list.png`
- `output/playwright/workflow-management-editor-mobile.png`
