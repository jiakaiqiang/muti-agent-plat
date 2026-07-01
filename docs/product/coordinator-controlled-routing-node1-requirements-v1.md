# 第一节点需求文档：Coordinator 需求接收与任务分配合同 v1

## 1. 节点定位

第一节点负责把用户自然语言需求转换为可分发、可执行、可验证的任务分配合同。

```text
用户需求
  -> Coordinator 理解需求
  -> Coordinator 生成任务计划
  -> Coordinator 拆分子任务
  -> Coordinator 指定负责 Agent
  -> 等待进入执行节点
```

本节点不执行任务，只形成后续执行所需的任务结构和分配关系。

## 2. 用户价值

用户希望系统不是让多个 Agent 自己抢任务，而是由一个主 Agent 先理解需求、拆清任务、明确谁负责什么，再让子 Agent 执行。

本节点解决：

- 任务开始前缺少统一理解。
- 子 Agent 重复理解全局需求。
- 任务归属不清导致流转混乱。
- 用户看不清任务为什么分配给某个 Agent。

## 3. 目标

- Coordinator 能接收用户需求并形成任务计划。
- 任务计划包含范围、非目标、约束、验收标准和风险。
- 每个子任务都有明确 `assigneeAgentId`。
- 每个子任务都有依赖关系和验收标准。
- 第一阶段默认 `routingMode=coordinator_controlled`。
- 子 Agent 自动流转不在本节点发生。

## 4. 范围

### 包含

- 用户需求解析。
- 任务契约生成或更新。
- 子任务拆分。
- 子任务分配。
- 任务依赖声明。
- 任务验收标准声明。
- 任务上下文需求声明。
- 为后续自动流转预留字段。

### 不包含

- 子 Agent 执行任务。
- 子 Agent 自动转派。
- 高风险工具调用。
- 最终交付生成。
- 真实分布式任务抢锁。

## 5. 主要用户流程

### 5.1 新需求进入

```text
用户输入需求
  -> 写入 user_message
  -> Coordinator 分析意图、范围和约束
  -> 生成 Task Brief
  -> 拆分 Agent Tasks
  -> 展示任务计划和分配结果
```

### 5.2 用户补充需求

```text
用户补充约束或修正目标
  -> Coordinator 判断是否影响任务契约
  -> 重新生成 Task Brief
  -> 重新拆分或调整任务分配
  -> 等待用户确认
```

### 5.3 用户确认执行

```text
用户确认 Task Brief
  -> 固化当前任务计划
  -> 任务进入分配后执行阶段
```

## 6. 产品需求

### P0

- Coordinator 必须是任务拆分和分配的唯一发起者。
- 每个子任务必须有明确标题、描述、验收标准和负责 Agent。
- 每个子任务必须声明 `routingMode=coordinator_controlled`。
- 系统不得展示“Agent 竞争接活”作为第一阶段能力。
- 用户确认前不得执行高风险操作。

### P1

- 任务计划中展示为什么分配给该 Agent。
- 任务计划中展示依赖关系。
- 任务计划中展示预计验证方式。
- 任务计划中标记可能需要用户确认的风险。

### P2

- 支持按 Agent 能力、Runtime 可用性、上下文命中情况辅助分配。
- 支持生成可视化任务依赖图。
- 支持对任务分配质量做复盘。

## 7. 任务计划输出

建议任务计划结构：

```json
{
  "goal": "完成用户确认的目标",
  "scope": ["包含事项"],
  "outOfScope": ["不做事项"],
  "constraints": ["约束"],
  "tasks": [
    {
      "title": "后端实现",
      "description": "实现接口逻辑",
      "assigneeAgentKey": "backend",
      "dependsOnTaskTitles": ["架构方案"],
      "acceptanceCriteria": ["接口测试通过"],
      "contextRequirements": ["API contract", "相关 service 文件"],
      "routingMode": "coordinator_controlled"
    }
  ]
}
```

## 8. 成功标准

- 用户可以看到 Coordinator 生成的任务计划。
- 用户可以看到每个任务分配给哪个 Agent。
- 用户可以理解任务分配理由。
- 用户确认前不会进入执行。
- 任务计划可以被后续执行节点直接消费。
- 后续节点中子 Agent 不能绕过 Coordinator 改变任务归属。

## 9. 风险与约束

- Coordinator 拆分质量会影响全链路。
- 任务分配过细会增加事件和上下文成本。
- 任务分配过粗会让子 Agent 仍需理解过多全局上下文。
- 现有 `claimed` 语义需要兼容，不能一次性破坏前后端合同。

## 10. 关联文档

- [Coordinator 中心流转与自动流转预留设计](../design/coordinator-controlled-routing-design-v1.md)
- [第一节点开发文档](../implementation/coordinator-controlled-routing-node1-development-v1.md)
- [第一阶段任务清单](../roadmap/coordinator-controlled-routing-phase1-tasks.md)

