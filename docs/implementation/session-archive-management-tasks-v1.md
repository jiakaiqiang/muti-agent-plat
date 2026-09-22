---
artifact: implementation_tasks
stage: implementation
producedBy: implementation
schemaVersion: "0.1"
status: implemented_with_deferred_follow_up
deliveryId: session-archive-management-v1
createdAt: 2026-09-21
---

# 会话归档管理 Tasks v1

- [x] T1 共享合同：`archivedAt`、`SessionArchiveGroup`。
- [x] T2 服务端列表过滤与项目分组投影。
- [x] T3 安全归档/恢复 API，复用停止证据和工作区 lease。
- [x] T4 Web/桌面会话侧栏三点操作、归档管理和恢复按钮。
- [x] T5 Web/桌面 Pinia 归档加载与操作状态同步。
- [x] T6 Web/桌面组件测试补充归档入口和恢复事件。
- [x] T7 增加真实 PostgreSQL 重启 smoke 和原生 Electron 归档/恢复 smoke 入口。
- [x] T8 重复归档/恢复请求的并发幂等测试。
- [x] T9 项目分组标题增加项目 ID、工作区名称和未归属项目回退。
- [x] T10 在具备 Docker/PostgreSQL、Electron 子进程权限的环境执行 T7 smoke 并归档证据：PostgreSQL 重启恢复与数据库 `archivedAt` 直读通过；原生 Electron 三点归档、归档管理和恢复通过（2026-09-21）。
- [ ] T11 接入独立项目目录后，将项目 ID 回退替换为项目名称解析。
- [ ] T12 归档保留周期、批量归档和管理员审计页面（后续范围）。
