# 阶段 0：合同收敛、现状基线与迁移边界 — Tasks v1

> 日期：2026-09-16
> 状态：阶段 0 已实现并验证；交付共享合同、纯校验、现状与迁移基线，不启用后续业务流程。
> 依赖：无；作为所有阶段的入口。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-0-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-0-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-0-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-0-checklist-v1.md)

## 执行规则

- 所有任务初始为待实施；先确认前置阶段退出条件，不跳过安全与确认门禁。
- 每项先补合同/失败用例，再实现；数据库、模型、CLI 与双端边界分别验证。
- 复用现有能力仍需回归，不将既有专项的通过记录直接复制为本阶段通过。
- 本阶段实施已完成，下列勾选只代表阶段 0 合同/基线交付；不代表后续业务入口已实现。各项实际证据见 Checklist。

## 任务清单

### P0-T1 建立现状与需求映射

- [x] 完成实现与审查。
- 前置：无；作为所有阶段的入口。
- 交付：源码入口、现有通过证据和差距表；明确哪些复用、哪些补强、哪些新增。
- 证据：[基线第 1/2 节](main-agent-collaboration-phase-0-baseline-v1.md)及本轮 40 项相关后端回归。
- 覆盖：P0-AC1、P0-AC5。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。

### P0-T2 冻结角色与执行身份

- [x] 完成实现与审查。
- 前置：P0-T1 完成；涉及的其他阶段依赖同页顶部。
- 交付：扩展共享合同与系统角色使用规则，列出禁止的 agentId 级执行状态。
- 证据：[共享合同源码](../../packages/shared/src/collaboration-contracts.ts)与 P0-AC1/2 单测；身份 key 不使用共享 Agent ID 作为唯一执行键。
- 覆盖：P0-AC1、P0-AC2。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。

### P0-T3 冻结用户交互与授权边界

- [x] 完成实现与审查。
- 前置：P0-T2 完成；涉及的其他阶段依赖同页顶部。
- 交付：确认 @、成员选择、主 Agent 文档、工作流选择/启动契约。
- 证据：[冻结合同第 3/4/10 节](../contracts/main-agent-collaboration-contract-v1.md)及精确确认/角色边界单测。
- 覆盖：P0-AC2、P0-AC3。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。

### P0-T4 设计迁移及策略快照

- [x] 完成实现与审查。
- 前置：P0-T3 完成；涉及的其他阶段依赖同页顶部。
- 交付：加法存储、版本兼容、活动会话分流与回退操作表。
- 证据：CollaborationPolicySnapshot 深冻结/兼容测试；[冻结合同第 5～9 节](../contracts/main-agent-collaboration-contract-v1.md)与基线迁移清单；实际部署演练未执行。
- 覆盖：P0-AC4、P0-AC6。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。

### P0-T5 建立契约和基线测试

- [x] 完成实现与审查。
- 前置：P0-T4 完成；涉及的其他阶段依赖同页顶部。
- 交付：新增身份/所有权/非法状态用例，运行已有停止、持久化、意图回归并登记结果。
- 证据：新增 15 项共享合同单测、6 项文档追踪检查；shared 全量 107 通过，后端定向 40 通过，全仓 typecheck、Harness、shared build 通过。
- 覆盖：P0-AC1、P0-AC4、P0-AC5。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。

### P0-T6 阶段评审与交接

- [x] 完成实现与审查。
- 前置：P0-T5 完成；涉及的其他阶段依赖同页顶部。
- 交付：审查 9 阶段依赖、参数策略和验证环境；未通过项阻止进入阶段 1。
- 证据：9 阶段 AC/Task/Checklist 追踪检查；阶段 1 计划已引用冻结合同；[Checklist](../quality/main-agent-collaboration-phase-0-checklist-v1.md)区分本阶段通过与后续未执行项。
- 覆盖：P0-AC3、P0-AC5、P0-AC6。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。

## 完成定义

AC 全部有审查/测试证据；状态所有权、迁移与策略快照明确；实现边界没有待裁决冲突。

完成一个任务不等于阶段完成；所有 AC 必须有证据。最后同步相关合同、测试说明与 Checklist，不修改其他未通过阶段的状态。
