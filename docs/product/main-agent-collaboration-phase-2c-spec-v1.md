# 阶段 2C：分层缓存、失效治理与成本观测 — Spec v1

> 日期：2026-09-16
> 状态：设计与实施基线，待实施；现有能力的复用不代表本阶段验收已完成。
> 依赖：阶段 2A、2B 通过；所有缓存必须服从阶段 1 生命周期。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-2c-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-2c-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-2c-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-2c-checklist-v1.md)

## 1. 目标与用户结果

减少重复检索、解析、摘要和模型前缀计算，同时保证缓存不串会话、不覆盖新需求、不掩盖真实 Token 使用。

## 2. 范围与非目标

- 文件/索引、摘要、角色上下文包、厂商提示词缓存分层设计。
- 实现依赖版本失效、并发回填保护、容量/TTL 治理和统一用量诊断。

非目标：

- 不使用缓存代替需求隔离或扩大上下文窗口，不把本地缓存命中当模型输入免费。
- 不缓存批准、停止、写文件、执行测试等有副作用操作的最终结果来跳过真实执行；不承诺固定降本比例。

## 3. 当前实现依据

- 已有按 workspace revision 命中的索引缓存，可复用失效思路。 [源码/既有文档](../../apps/server/src/modules/workspaces/workspace-index/workspace-index-cache.ts)
- Claude 流解析已提取缓存读/写输入 Token；其他 Runtime 需要逐项核实映射与语义。 [源码/既有文档](../../packages/shared/src/runtime-streaming/claude-stream-json-parser.ts)
- Generic LLM 组装 system/user 上下文与多轮工具历史，是发送前预算和缓存能力适配落点。 [源码/既有文档](../../apps/server/src/modules/runtimes/generic-llm-runtime.service.ts)

以上为现状定位，不等于本专项测试结果；实施前复核当前工作树，不覆盖无关改动。

## 4. 验收条件

- P2C-AC1：四类缓存分别定义用途、依赖和成本归属；本地缓存不会自动减少发送 Token，厂商提示词缓存仍纳入完整上下文预算。
- P2C-AC2：私有缓存 key 包含 Session/WorkItem/角色与相关内容版本，公共模板只复用无私有数据部分；读取和回填均检查生命周期。
- P2C-AC3：失效按真实业务依赖：需求、决策、文件 hash、工具/策略、模型配置变化触发相关项失效；心跳、无关流式事件不造成全量失效。
- P2C-AC4：摘要/上下文缓存防击穿并有限重试；缓存后端失败可回源，但回源仍受预算、取消、权限与并发限制。
- P2C-AC5：按实际 Runtime 声明提示词缓存能力、参数和用量字段；稳定前缀与动态尾部合理分离，不改变内容信任层级。
- P2C-AC6：记录每需求/阶段/调用的输入、输出、缓存读/写、摘要/检索额外成本与延迟，按供应商语义归一化，避免重复累加。
- P2C-AC7：派生缓存具备容量上限、LRU/TTL、版本化淘汰与可观测性；原始记录和确认事实不因缓存过期被清除。

## 5. 约束与风险

- 缓存命中率上升不等于总成本下降，摘要生成/写缓存费用和更多调用必须一起统计。
- 不同 provider 的 input_tokens 是否含缓存部分不同，必须按实际响应合同归一化。

共同约束：复用 v2-only、现有 Runtime/Tool Authority 和持久化事务边界；Web 与桌面共享业务状态但保留各自样式；不自动重跑历史任务、不清库、不变更凭据或外部权限。

## 6. 阶段退出

失效/隔离/并发/容量测试通过；成本可解释，未知值不伪装为零；缓存不可绕过预算或真实执行。

本阶段详细任务和证据填写位置见 Tasks/Checklist。只有实现与必须验证均完成后才可更新状态，文档生成不勾选开发项。
