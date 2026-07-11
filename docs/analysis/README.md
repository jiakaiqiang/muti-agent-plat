# Analysis Docs

本目录存放项目现状、功能盘点和问题分析。

- `feature-inventory-and-status-v1.md`：功能清单、业务流程、问题分级与最新进展。
- `project-analysis.md`：项目结构、运行现状、主要风险和改进建议。
- `multica-runtime-comparison-v1.md`：与 multica 的运行时/CLI 执行层深度对比（进程模型、输出契约、存活判定、会话续接）。
- `agent-cluster-vs-multica-architecture-v1.md`：与 multica 的全景架构对比（Actor 多态、Skill、Session Resumption、Autopilot、事件时间线）与分模块改造优先级。
- `multica-actionable-refactor-plan-v1.md`：对标本仓库真实代码（带文件行号、关联 bug/commit）的可落地改造方案，逐条给出现状→为何改→怎么改→收益→验收，并标注 AI 可协助 / 需手写边界。

两份文档相互补充：

- 想看“当前实现了什么、还缺什么”，优先读 `feature-inventory-and-status-v1.md`。
- 想看“项目结构如何、风险在哪里”，优先读 `project-analysis.md`。
