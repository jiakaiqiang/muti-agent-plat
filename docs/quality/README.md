# Quality Docs

- `runtime-output-contract-hard-cutover-verification-v1.md`：Runtime 输出合约集中管理、Schema 3 硬切换、事件隔离和真实 Codex 验收证据。

- `workflow-v1-implementation-acceptance.md`：工作流管理、低代码编辑器、显式确认节点和运行时 V1 的实现映射与验收证据。
- `local-and-server-runtime-workspace-separation-acceptance-v1.md`：Local Runtime CLI、服务器独立 Worker、工作区边界、断线语义和后端 PID 稳定性的逐项验收证据。
- `workspace-index-first-acceptance-v1.md`：目录选择与 Session 创建解耦、索引导航、按需取证、revision 竞速、多 Session 绑定和性能夹具的验收映射。

本目录存放 v1/v1+ 验收矩阵、闭环验收报告和后续质量证据。

- `v1-acceptance-matrix.md`：v1 发布门、P1/P2 质量门和当前 v1+ hardening gates。
- `v1-closure-acceptance-report.md`：v1 闭环验收报告，记录 UX、数据一致性、安全和发布建议。
- `multica-p0-acceptance-report-v1.md`：Multica 对标改造 P0 的 PostgreSQL、Redis/BullMQ、Workdir Brief 和真实 CLI 验收状态与证据。
- `multica-p1-acceptance-report-v1.md`：Multica 对标改造 P1 的 Watchdog 基线与 Skill 管理前端验收状态；明确真实采样门禁和剩余动作。

更新功能、运行时、队列、恢复、工作区或安全边界时，应同步检查验收矩阵中的证据是否仍指向当前测试脚本。
