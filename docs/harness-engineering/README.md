# Agent Cluster Harness Engineering 工程化体系

## 适用范围

这套方法论不只服务于 Agent Cluster；Agent Cluster 只是当前实例。它也适用于其他多 Agent 协作、AI/人工混合交付、自动化研发流程和需要阶段治理的知识工作。


Harness Engineering 不是测试、不是系统功能、不是某个模块。

它是 Agent 工作方式的工程化规程，用来约束一次研发交付如何从需求走到结果：

```text
需求表达 -> 上下文构造 -> Agent 分工 -> 阶段交接 -> 工具治理 -> 人工干预 -> 反馈返工 -> 交付记忆
```

本目录定义 Agent Cluster 的 Harness Engineering 第一阶段规程。第一阶段不实现系统功能，不聚合测试，也不引入 API；只建立 Agent 协作时必须遵守的工程规则。

## 核心规程

| 编号 | 规程 | 作用 |
| --- | --- | --- |
| 01 | [Intent Contract](./01-intent-contract.md) | 把用户需求变成可交接、可评审、可验收的需求契约 |
| 02 | [Context Protocol](./02-context-protocol.md) | 规定每个阶段的 Agent 应该看到哪些上下文 |
| 03 | [Agent Role Protocol](./03-agent-role-protocol.md) | 规定 Agent 角色边界和越权处理 |
| 04 | [Stage Workflow](./04-stage-workflow.md) | 规定阶段顺序、准入条件、退出条件和交接产物 |
| 05 | [Tool Governance](./05-tool-governance.md) | 规定工具使用风险等级、留痕和人工确认要求 |
| 06 | [Human Intervention](./06-human-intervention.md) | 规定什么时候必须让用户或人工决策介入 |
| 07 | [Feedback Loop](./07-feedback-loop.md) | 规定失败如何分类，以及应该回到哪个阶段 |
| 08 | [Delivery Memory](./08-delivery-memory.md) | 规定交付结束后如何沉淀项目知识 |

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

## 第一阶段目标

第一阶段的完成标准：

```text
现有 Agent 协作过程可以按统一规程：
- 表达需求
- 传递上下文
- 分配角色
- 控制工具
- 处理人工确认
- 判断返工
- 交付结果
- 沉淀经验
```

第一阶段不做：

```text
不新增后端模块
不新增前端页面
不设计 API
不把 Harness Engineering 变成测试平台
```

## 第二阶段目标

第二阶段不是写代码，也不是新增系统功能。

第二阶段的目标是让现有 Agent Cluster 协作过程对齐第一阶段规程：

```text
让现有需求生成、Agent 讨论、任务拆解、执行、复盘和交付过程，
开始按 8 个工程规程运行。
```

执行说明见：[09-phase-two-alignment.md](./09-phase-two-alignment.md)。

## 第三阶段目标

第三阶段仍然不是写代码，也不是新增系统功能。

第三阶段的目标是把第一阶段规程、第二阶段对齐结果，固化成每个 Agent 的工作协议：

```text
让每个 Agent 知道：
- 自己负责什么
- 不负责什么
- 开始前必须拿到什么输入
- 结束时必须交出什么产物
- 遇到越权、缺上下文、权限不足、需求不清时应该怎么处理
```

执行说明见：[10-agent-working-protocol.md](./10-agent-working-protocol.md)。

## 第四阶段目标

第四阶段仍然不是写代码，也不是新增系统功能。

第四阶段的目标是建立交付记忆与复盘机制：

```text
让每次 Agent 协作交付结束后，
都能沉淀出可复用的项目知识、失败模式、设计决策和用户偏好，
同时避免把一次性噪音写成长期记忆。
```

执行说明见：[11-delivery-memory-practice.md](./11-delivery-memory-practice.md)。

## 第五阶段目标

第五阶段仍然不是写代码，也不是新增系统功能。

第五阶段的目标是建立持续治理与演进机制：

```text
定期检查 Harness Engineering 规程是否仍然被遵守，
发现 Agent 行为漂移、上下文膨胀、工具治理绕过、交付记忆污染等问题，
并把这些问题反馈到规程、Agent 工作协议和交付记忆中。
```

执行说明见：[12-continuous-governance.md](./12-continuous-governance.md)。

## 使用方式

每次研发任务开始前，先按 `01-intent-contract.md` 形成需求契约。

每个阶段开始前，按 `02-context-protocol.md` 构造上下文，并按 `03-agent-role-protocol.md` 选择 Agent。

阶段推进按 `04-stage-workflow.md` 执行；工具使用按 `05-tool-governance.md` 管理；遇到不确定、高风险或范围变化，按 `06-human-intervention.md` 处理。

失败后按 `07-feedback-loop.md` 分类返工。

交付完成后按 `08-delivery-memory.md` 沉淀经验。
