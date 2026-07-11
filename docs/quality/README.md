# Quality Docs

本目录存放 v1/v1+ 验收矩阵、闭环验收报告和后续质量证据。

- `v1-acceptance-matrix.md`：v1 发布门、P1/P2 质量门和当前 v1+ hardening gates。
- `v1-closure-acceptance-report.md`：v1 闭环验收报告，记录 UX、数据一致性、安全和发布建议。
- `multica-p0-acceptance-report-v1.md`：Multica 对标改造 P0 的 PostgreSQL、Redis/BullMQ、Workdir Brief 和真实 CLI 验收状态与证据。
- `multica-p1-acceptance-report-v1.md`：Multica 对标改造 P1 的 Watchdog 基线与 Skill 管理前端验收状态；明确真实采样门禁和剩余动作。

更新功能、运行时、队列、恢复、工作区或安全边界时，应同步检查验收矩阵中的证据是否仍指向当前测试脚本。
