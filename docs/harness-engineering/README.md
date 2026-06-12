# Agent Cluster Harness Engineering 工程化体系

> 最后修改时间：2026-06-12 11:20:34 +08:00
> 修改人：Claude Code
> 修改的 Agent：Claude Code

## 适用范围

这套方法论不只服务于 Agent Cluster；Agent Cluster 只是当前实例。它也适用于其他多 Agent 协作、AI/人工混合交付、自动化研发流程和需要阶段治理的知识工作。

Harness Engineering 是约束 AI Agent 交付行为的外部工程模型，不是业务系统功能；完整边界见 [00-boundary-and-principles.md](./00-boundary-and-principles.md)。

它用来约束一次研发交付如何从需求走到结果：

```text
需求表达 -> 上下文构造 -> Agent 分工 -> 阶段交接 -> 工具治理 -> 人工干预 -> 反馈返工 -> 交付记忆
```

本目录建立 Agent 协作时必须遵守的工程规则：不实现系统功能，不聚合测试，不引入 API。

## 文档分层

分层只通过 README 表格与文档头部声明表达，不移动文件，不重编号。

| 层级 | 内容 | 文档 |
| --- | --- | --- |
| core | 可迁移的通用约束规程 | `00`、`01`-`08`、`10`、`12` |
| templates | 阶段产物模板 | `templates/` 下 7 个模板 |
| reference | Agent Cluster 专属映射与实践 | `09`、`11`、`alignment/`、`prompt-context/`、`capability-binding/`、`delivery-memory/`、`reference/` |

## 编号说明

本目录同时保留两类历史编号，避免把 Harness 本体和 Agent Cluster 参考映射混为一谈。

| 编号体系 | 用途 | 示例 |
| --- | --- | --- |
| Protocol Evolution | 说明 Harness core 规程如何逐步建立和治理 | 第一阶段核心规程、第二阶段流程对齐、第三阶段 Agent 工作协议、第四阶段交付记忆、第五阶段持续治理 |
| Reference Binding | 说明 Agent Cluster 当前实现如何映射 Harness | Phase 2 Runtime Alignment、Phase 3 Prompt/Context、Phase 4 Capability、Phase 5 Delivery Memory |

Reference Binding 只解释 Agent Cluster 的 `SessionStatus`、`ContextPack`、`Capability`、`RuntimeInvocation`、`Memory` 等业务概念如何承载 Harness 语义，不把这些概念反推为 Harness 本体要求。

## 四要素总览

Harness Engineering 的约束模型按四要素组织：

| 要素 | 控制什么 | 主文档 | 支撑文档 |
| --- | --- | --- | --- |
| Context Management 上下文管理 | AI 看什么、信什么、保留什么、丢弃什么 | 02 | 01、08 |
| Architecture Constraints 架构约束 | AI 能动哪里、不能破坏什么、如何保持结构稳定 | 03、04 | 05、10 |
| Feedback Loop 反馈循环 | 出错后如何回退、修正、验证、收敛 | 07 | 06、12 |
| Entropy Management 熵管理 | 上下文、规则、记忆、范围、行为长期不发散 | 12 | 08、02 |

## 核心规程

| 编号 | 规程 | 作用 |
| --- | --- | --- |
| 00 | [Boundary and Principles](./00-boundary-and-principles.md) | 定义 Harness 的边界：约束 AI Agent，而不是业务系统功能 |
| 01 | [Intent Contract](./01-intent-contract.md) | 把用户需求变成可交接、可评审、可验收的需求契约 |
| 02 | [Context Protocol](./02-context-protocol.md) | 规定每个阶段的 Agent 应该看到哪些上下文 |
| 03 | [Agent Role Protocol](./03-agent-role-protocol.md) | 规定 Agent 角色边界和越权处理 |
| 04 | [Stage Workflow](./04-stage-workflow.md) | 规定阶段顺序、准入条件、退出条件和交接产物 |
| 05 | [Tool Governance](./05-tool-governance.md) | 规定工具使用风险等级、留痕和人工确认要求 |
| 06 | [Human Intervention](./06-human-intervention.md) | 规定什么时候必须让用户或人工决策介入 |
| 07 | [Feedback Loop](./07-feedback-loop.md) | 规定失败如何分类，以及应该回到哪个阶段 |
| 08 | [Delivery Memory](./08-delivery-memory.md) | 规定交付结束后如何沉淀项目知识 |
| 10 | [Agent Working Protocol](./10-agent-working-protocol.md) | 把规程固化为每个 Agent 的输入、产出和异常处理协议 |
| 12 | [Continuous Governance](./12-continuous-governance.md) | 持续治理、熵管理与规程演进 |

## 附录模板

模板只是辅助，不是主线规程。

```text
templates/
  intent-contract-template.md
  design-plan-template.md
  task-plan-template.md
  implementation-summary-template.md
  verification-result-template.md
  review-report-template.md
  final-delivery-template.md
```

## 演进历史

体系分五个阶段建成。阶段目标保留为演进记录，不再作为本目录的主组织方式（主组织方式是上方的文档分层与四要素）：

| 阶段 | 目标 | 说明文档 |
| --- | --- | --- |
| 第一阶段 | 建立 8 个核心规程与 7 个模板，不实现系统功能 | 本目录 `01`-`08`、`templates/` |
| 第二阶段 | 让 Agent Cluster 现有协作流程对齐规程 | [09-phase-two-alignment.md](./09-phase-two-alignment.md) |
| 第三阶段 | 把规程固化为每个 Agent 的工作协议 | [10-agent-working-protocol.md](./10-agent-working-protocol.md) |
| 第四阶段 | 建立交付记忆与复盘机制 | [11-delivery-memory-practice.md](./11-delivery-memory-practice.md) |
| 第五阶段 | 建立持续治理与演进机制 | [12-continuous-governance.md](./12-continuous-governance.md) |

## 使用方式

每次研发任务开始前，先按 `01-intent-contract.md` 形成需求契约。

每个阶段开始前，按 `02-context-protocol.md` 构造上下文，并按 `03-agent-role-protocol.md` 选择 Agent。

阶段推进按 `04-stage-workflow.md` 执行；工具使用按 `05-tool-governance.md` 管理；遇到不确定、高风险或范围变化，按 `06-human-intervention.md` 处理。

失败后按 `07-feedback-loop.md` 分类返工。

交付完成后按 `08-delivery-memory.md` 沉淀经验。
