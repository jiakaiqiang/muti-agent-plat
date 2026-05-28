# Agent Cluster v0.1 契约索引

本目录是 v1 开发开工前的最小契约集合。

这些契约用于支撑 Frontend、Backend、Runtime、RAG、Test、Quality Acceptance 等 Agent Team 并行开发。v0.1 不是最终版本，但在 Milestone 1 到 Milestone 3 期间应保持稳定。字段如需变更，必须通过 `api_contract_updated` 或 `event_contract_updated` 协作事件通知相关 Team。

## 契约清单

- [event-contract-v0.1.md](./event-contract-v0.1.md)：协作事件类型、payload、metadata、SSE 推送、前端渲染规则。
- [api-contract-v0.1.md](./api-contract-v0.1.md)：Session、Event、Agent、Task Brief、Knowledge、Artifact 的核心 API。
- [data-contract-v0.1.md](./data-contract-v0.1.md)：v1 最小数据模型、枚举、关系和索引。
- [ui-state-contract-v0.1.md](./ui-state-contract-v0.1.md)：会话状态、任务状态、Agent 状态、确认卡片状态、前端 Store 派生规则。
- [runtime-contract-v0.1.md](./runtime-contract-v0.1.md)：MockRuntime、GenericLlmRuntime 和后续 Coding Runtime 的统一输入输出接口。

## v0.1 使用规则

- 前端先基于 Event Contract 和 API Contract mock 数据开发。
- 后端先基于 Data Contract 和 Runtime Contract 实现 MockRuntime 闭环。
- 测试优先基于 Event Contract、API Contract 和 UI State Contract 写契约测试和 E2E 骨架。
- Runtime Team 必须保证所有 Runtime 输出可转换为 `collaboration_events`。
- RAG 和 Memory 的能力可以在 Milestone 4 完整接入，但 v0.1 数据和 API 需要提前预留。

## 变更规则

契约字段变更分三级：

- patch：新增可选字段，不影响既有前后端。
- minor：新增事件类型、接口或枚举，需要相关 Team 同步。
- breaking：删除字段、修改字段语义、修改状态流转，必须由 System Coordinator 组织评审。

第一阶段建议只做 patch/minor，避免 breaking。
