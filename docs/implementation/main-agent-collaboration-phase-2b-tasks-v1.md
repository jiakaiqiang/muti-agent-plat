# 阶段 2B：版本化长期记忆、增量摘要与历史需求召回 — Tasks v1

> 日期：2026-09-16
> 状态：T1-T6 已完成并验收（2026-09-18）。
> 依赖：阶段 2A 通过；使用阶段 1 生命周期/取消屏障。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-2b-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-2b-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-2b-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-2b-checklist-v1.md)

## 执行记录

- 阶段 2A 前置已通过；T1-T6 串行完成，新增用例进入 Server 自动发现的全量测试。
- file、独立 PostgreSQL、CLI 隔离/轮换、取消/恢复/删除和全仓门禁均重新执行，没有复制旧专项结果。
- 未运行真实付费模型、部署或发布；外部语义召回仍为可选能力，当前低可信路径要求用户澄清。

## 任务清单

### P2B-T1 扩展权威事实与检查点合同

- [x] 完成实现与审查。
- 前置：阶段 2A 通过；使用阶段 1 生命周期/取消屏障。
- 交付：保留现有实体，补 coveredEventSeq、版本、来源及唯一逻辑键/迁移。
- 覆盖：P2B-AC1、P2B-AC2、P2B-AC3。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。

### P2B-T2 实现增量摘要任务

- [x] 完成实现与审查。
- 前置：P2B-T1 完成；涉及的其他阶段依赖同页顶部。
- 交付：阈值/阶段触发、预算预留、single-flight/跨进程唯一提交、停止与失败处理。
- 覆盖：P2B-AC2、P2B-AC3、P2B-AC6。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。

### P2B-T3 实现决策替代与摘要校验

- [x] 完成实现与审查。
- 前置：P2B-T2 完成；涉及的其他阶段依赖同页顶部。
- 交付：消除已解决问题/过期约束，迟到结果拒绝，增加来源回查。
- 覆盖：P2B-AC1、P2B-AC3、P2B-AC6。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。

### P2B-T4 实现有界历史召回

- [x] 完成实现与审查。
- 前置：P2B-T3 完成；涉及的其他阶段依赖同页顶部。
- 交付：需求索引、词法/可选语义适配、候选重排、低可信澄清与显式继承。
- 覆盖：P2B-AC4、P2B-AC5。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。

### P2B-T5 实现历史分页与 CLI 交接

- [x] 完成实现与审查。
- 前置：P2B-T4 完成；涉及的其他阶段依赖同页顶部。
- 交付：历史 API 有界分页、PostgreSQL 数据库页查询、file 端 32 页 LRU；运行历史隔离、检查点轮换与副作用去重。file backend 启动仍保留完整 JSON/事件投影，不宣称完全懒加载。
- 覆盖：P2B-AC5、P2B-AC7。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。

### P2B-T6 验证长会话与摘要竞争

- [x] 完成实现与审查。
- 前置：P2B-T5 完成；涉及的其他阶段依赖同页顶部。
- 交付：百需求、千消息、早期需求召回、版本冲突、删除/重启/模型失败及原文保留。
- 覆盖：P2B-AC1、P2B-AC2、P2B-AC3、P2B-AC4、P2B-AC5、P2B-AC6、P2B-AC7。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。

## 完成定义

长会话可继续、旧需求可追溯、旧摘要不能覆盖新决定、取消与 CLI 交接不重播副作用；最终输入通过 2A 预算。

完成一个任务不等于阶段完成；本阶段 6 项任务和 7 条 AC 的证据均已回填 Checklist。阶段 2C 及以后仍保持待实施，不因 2B 通过而自动变更状态。

## 实施摘要

- T1-T3：新增版本化检查点 store/service、V12 PostgreSQL 表及投影；当前摘要只保留有效决定、当前已确认约束/验收标准，旧决定仅保留来源引用。
- T4：新增 WorkItem 归档索引和有界召回，接入 Intent Snapshot；相似、弱匹配和索引不可用均 fail closed 到澄清。
- T5：新增事件分页与有界 LRU；CLI resume 绑定 WorkItem/generation，累计输入超过阈值后轮换，LogicalOperation 继续阻止副作用重播。
- T6：100 需求/1,000 消息、迟到摘要、跨实例唯一提交、取消/删除/恢复及预算恢复均已覆盖；证据日期为 2026-09-18。
