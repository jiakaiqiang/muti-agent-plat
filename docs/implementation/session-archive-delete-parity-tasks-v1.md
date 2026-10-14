---
artifact: implementation_tasks
stage: implementation
schemaVersion: "0.1"
deliveryId: session-archive-delete-parity-v1
createdAt: 2026-09-27
---

# 群聊归档管理列表与删除列表对齐 Tasks v1

用户需求（原话三条）：

1. 群聊中「归档管理」的列表要和「删除」的列表保持一致（同样的会话卡片渲染）。
2. 删除的会话不支持恢复。
3. 归档列表中的会话支持恢复和删除。

已定方案（用户确认按读法 A）：需求 2 只去掉 UI 恢复入口，**不改后端墓碑与 `/restore` API**，
数据仍可恢复只是用户点不到。删除仍是可恢复墓碑，不物理清除。

## 任务清单（做完才勾）

- [x] T1 shared：`SessionArchiveItem` 拓宽出 `status` / `lifecycleState`
      （后端 `listArchivedGroups` 本就推完整 list 项，仅类型窄）。重建 shared dist。
- [x] T2 后端：放开 `delete()` 对 `archivedAt` 的拦截，删除完成时清 `archivedAt`
      使删完不残留归档态；`archive()` 对 deleted 的拦截保留（已删不能归档）。
- [ ] T3 后端 spec：新增「归档会话可直接删除，删完不再出现在归档分组」
      和「删除卡在 deleting 时不能从归档恢复」两条用例（sessions.service.spec.ts:2206/:2221）。
      用例已写，实跑被工具环境阻断（shell 分类器持续超时），待环境恢复后执行：
      `tsx --test --test-name-pattern="an archived Session" src/modules/sessions/sessions.service.spec.ts`。
- [x] T4 前端 web `SessionSidebar.vue`：归档管理页签改用会话卡片 + 右键菜单
      （恢复 + 删除）；「已删除」页签去掉「恢复会话」项。
- [x] T5 前端 desktop `SessionSidebar.vue`：同 T4。
- [x] T6 两端 `SessionSidebar.spec.ts`：更新断言（归档删除/恢复、已删除无恢复入口）。
- [x] T7 desktop e2e 选择器 `session-archive-desktop-smoke.mjs`：适配新结构。
- [ ] T8 验证：typecheck + web/shared/server 单测 + 相关 e2e。

## 已核实事实

- 归档会话 lifecycle = `state='active'` + `admission='closed'`，不是 deleted。
- `list('deleted')` 只看 `state==='deleted'`；`list('archived')` 要求 `state!=='deleted' && archivedAt`。
  故删除后 archivedAt 残留不影响列表归类，但语义不净，T2 顺手清。
- `SessionArchiveItem` 只在 shared 定义，web/desktop 仅 re-export `SessionArchiveGroup`。
- 删除入口：sidebar `@delete` → `SessionWorkspace.requestDeleteSession` 弹确认框 → `confirmDeleteSession`。
- 后端启动依赖 dev 库无夹具残留（本轮已清 pid 2384/53800 两棵测试夹具树，5 个真实会话完好）。

## 2026-09-29 构建阻挡修复

用户批准将两端侧栏构建阻挡纳入请求健康专项。本轮仅清理残留的已删除会话恢复按钮、`emit('restore')` 与 Workspace `@restore` 绑定，未回退并行归档卡片改动，也未改后端墓碑/恢复 API。桌面已删除条目去掉误导性的可点击 role/tabindex，保留原选择拦截；归档恢复、删除与原删除确认流程仍保留。

整仓 `npm run typecheck` / `npm run build` 均退出 0；两端侧栏、删除生命周期、Workspace、请求健康面板及文档组件定向 35 项通过；Web 全量复跑 372 项通过，Desktop 主进程单测 14 项通过。Web 首次全量的 1 项无关异步测试失败另见请求健康 Checklist V9，未修改该组件。本轮未重启原前后端服务。

`npm run test:e2e:session-archive-desktop` 最终退出 0：随机端口 26389、独立 file 数据和临时桌面 profile，强制 Mock Runtime。验证三点菜单归档、归档卡片、恢复接口、全部页签、选中卡片及服务端归档标记清除；截图已复核。脚本增加失败页面/控制台诊断，避免旧卡片造成恢复假通过。首次超时与旧断言的无效通过保留在请求健康 Checklist V10；隔离服务已停止，测试数据已清理。`npm run test:harness` 全阶段通过。此证据不代替归档删除的后端/PG 全验收，T2/T3/T8 保持未勾选。
