# 协作计划区域滚动验证

日期：2026-09-29。

## 要求与改动

内容较多时，任务计划与协作过程在各自列表内滚动；上方计划标题、进度、统计及两栏标题保持可见。

- `CollaborationPlanView.vue` 的两个列表支持聚焦和键盘滚动，使用对应标题作为可访问名称。
- `styles.css` 使用受限高度的 Grid 布局，根容器不滚动，列表 `overflow: auto`，并阻止滚动传递到外层。
- 窄窗口两栏上下排列，仍各自滚动。

## 浏览器验证

通过 Playwright CLI 使用真实 Vue 组件和生产 CSS；隔离 fixture 包含 30 个任务、40 条过程记录，不访问后端或模型。

| 窗口 | 列表高度 | 结果 |
| --- | --- | --- |
| 1532 × 917 | 562px | 左右列表均可滚动，外层与 document 无纵向溢出，计划标题位置不变 |
| 1280 × 600 | 245px | 同上；End 键到右栏底部后继续滚轮，右栏滚动约 3282px，左栏保持 500px，外层与页面 scrollTop 均为 0 |
| 390 × 844 | 133px | 上下列表均可滚动，外层与 document 无纵向溢出，计划标题位置不变 |

其他验证：`CollaborationPlanView.spec.ts` 5/5 通过，`npm run typecheck -w @project/web` 通过。

复现入口：启动 Web Vite 后打开 `/tests/fixtures/collaboration-plan-scroll.html`，用鼠标或 Tab 聚焦列表后使用方向键、PageDown、End 滚动。

本次只修改 Web 协作计划组件和对应样式，不改变其他页面的滚动方式。
