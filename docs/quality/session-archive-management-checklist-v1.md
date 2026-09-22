---
artifact: acceptance_checklist
stage: quality
producedBy: quality
schemaVersion: "0.1"
status: implemented_with_deferred_follow_up
deliveryId: session-archive-management-v1
createdAt: 2026-09-21
---

# 会话归档管理 Checklist v1

## 已覆盖

- [x] 普通列表不展示 `archivedAt` 会话。
- [x] 三点入口同时提供归档和删除，删除语义不变。
- [x] 归档按项目分组，恢复按钮回到普通列表。
- [x] 归档前关闭准入并等待停止证据；停止失败不隐藏会话。
- [x] 恢复校验工作区可用性和 lease，恢复后保持暂停。
- [x] Web 与桌面共享接口，未合并两端样式文件。
- [x] 已提供并执行 PostgreSQL 归档重启 smoke：`npm run test:e2e:session-archive-postgres`；活动列表、项目分组、重启后 `archivedAt` 持久化、恢复和数据库直读均通过（2026-09-21）。
- [x] 已提供并执行原生 Electron 归档/恢复 smoke：`npm run test:e2e:session-archive-desktop`；真实 Electron 三点归档、归档管理和恢复均通过（2026-09-21）。
- [x] 重复归档/恢复请求已有服务层幂等覆盖。
- [x] 项目分组标题有项目 ID、工作区名称和未归属项目回退。

## 待补充

- [ ] 多窗口并发归档、恢复冲突与批量操作验收。
- [ ] 接入项目目录后验证项目名称解析和项目重命名回退。
