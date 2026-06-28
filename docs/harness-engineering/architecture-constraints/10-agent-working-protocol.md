# 10 Agent Working Protocol 第三阶段 Agent 工作协议

> **工程化定位** · 控制面: Architecture Constraints · 权威来源: 本文件 · 修改触发: 经 12 Governance 边 ⑦ 回写

## 目的

第三阶段不是写代码，不是新增系统功能，也不是把规程做成自动化流程。

第三阶段的目标是：

```text
把 Harness Engineering 的 8 个工程规程，转化成每个 Agent 实际工作时必须遵守的行为协议。
```

第一阶段解决“有哪些规程”。

第二阶段解决“现有协作流程和规程哪里不一致”。

第三阶段解决：

```text
每个 Agent 以后具体应该怎么工作。
```

## 第三阶段要解决的问题

如果只有规程，但 Agent 的实际工作方式没有改变，Harness Engineering 仍然停留在文档层。

常见问题：

```text
Requirement Agent 直接给技术方案
Architect Agent 开始写实现细节
Implementation Agent 顺手扩大范围
Verification Agent 只跑命令，不检查需求覆盖
Review Agent 只总结，不做独立判断
Delivery Agent 只输出结果，不沉淀经验
```

第三阶段要把这些行为改成明确的 Agent 工作协议。

## 对齐前提

第三阶段开始前，应已完成：

```text
第一阶段：8 个工程规程已建立
第二阶段：现有协作流程已完成对齐评估
```

第三阶段输入（路径以 `.claude/harness-engineering/` 为根，物理拆分到四控制面目录）：

```text
context-engineering/01-intent-contract.md
context-engineering/02-context-protocol.md
architecture-constraints/03-agent-role-protocol.md
architecture-constraints/04-stage-workflow.md
architecture-constraints/05-tool-governance.md
feedback-loop/06-human-intervention.md
feedback-loop/07-feedback-loop.md
entropy-management/08-delivery-memory.md
legacy/09-phase-two-alignment.md
alignment/phase-two-alignment-report.md
```

## 第三阶段输出

第三阶段建议产出：

```text
docs/harness-engineering/agent-instructions/
  requirement-agent.md
  architect-agent.md
  coordinator-agent.md
  implementation-agent.md
  verification-agent.md
  review-agent.md
  delivery-agent.md
```

这些文件不是代码，也不是系统提示词实现。

它们是 Agent 工作协议草案，用来指导后续如何调整 Agent 提示词、协作规程和人工评审标准。

## 边界引用

所有 Agent 的角色边界（负责 / 不负责 / 硬规则 / 标准命名表）以 [`03-agent-role-protocol.md`](./03-agent-role-protocol.md) 为权威。本文件不再重复定义，专注于执行层：必须输入、必须输出、返工触发。


## 通用 Agent 工作协议

所有 Agent 都必须遵守：

```text
1. 只处理自己阶段内的问题。
2. 不擅自修改上游阶段结论。
3. 不扩大需求范围。
4. 不绕过工具治理。
5. 不把待确认问题当成已确认事实。
6. 不用口头总结替代结构化交接产物。
7. 发现上游问题时，通过 Feedback Loop 回退。
8. 结束阶段时，必须说明产物、风险、未决问题和下游注意事项。
```

## Requirement Agent 工作协议

### 必须输入

```text
用户原始需求
已有背景
用户偏好或约束
```

### 必须输出

```text
Intent Contract
待确认问题
是否允许进入 Design 的判断
```

### 返工触发

```text
目标不清
验收标准不可判断
需求范围变化
设计或评审发现需求遗漏
```

## Architect Agent 工作协议

### 必须输入

```text
Intent Contract
项目上下文
相关契约
相关代码范围
已知约束
```

### 必须输出

```text
Design Plan
影响范围
风险与缓解
验收标准覆盖关系
需要人工确认的高影响方案
```

### 返工触发

```text
需求契约不足以支撑设计
设计未覆盖验收标准
设计越界
存在多个高影响方案但未确认
```

## Coordinator Agent 工作协议

### 必须输入

```text
Design Plan
Agent Role Protocol
Tool Governance
Context Protocol
```

### 必须输出

```text
Task Plan
Agent 分配
依赖顺序
允许范围
工具风险提示
```

### 返工触发

```text
任务拆分过粗或过细
依赖关系错误
任务范围不清
任务无法覆盖设计
```

## Implementation Agent 工作协议

### 必须输入

```text
Task Plan
Design Plan
允许范围
工具治理规则
验收标准
```

### 必须输出

```text
Implementation Summary
完成任务清单
范围偏差
工具使用记录
待验证项
```

### 返工触发

```text
发现设计无法实现
发现任务范围不足
需要高风险工具但未确认
上下文不足
```

## Verification Agent 工作协议

### 必须输入

```text
Intent Contract
Design Plan
Implementation Summary
待验证项
```

### 必须输出

```text
Verification Result
验收证据
缺陷列表
阻塞原因
建议回退阶段
```

### 返工触发

```text
验收标准未满足
证据不足
验证方式不可靠
实现结果与设计不一致
```

## Review Agent 工作协议

### 必须输入

```text
Intent Contract
Design Plan
Task Plan
Implementation Summary
Verification Result
返工记录
人工确认记录
```

### 必须输出

```text
Review Report
评审发现
决策
返工目标阶段
需要用户确认的问题
```

### 返工触发

```text
需求未覆盖
设计与需求不一致
实现越界
验证证据不足
风险未处理
范围发生变化
```

## Delivery Agent 工作协议

### 必须输入

```text
全部阶段产物
Review Report
剩余风险
人工确认记录
```

### 必须输出

```text
Final Delivery
Delivery Memory
后续建议
```

### 返工触发

```text
Review 未 approve
交付摘要无法追溯到验收标准
未完成项未说明
交付记忆缺失
```

## 第三阶段不做什么

第三阶段不做：

```text
不新增系统功能
不写代码
不新增 API
不把协议固化成程序
不做测试平台
```

第三阶段只做：

```text
Agent 工作协议
Agent 输入输出边界
Agent 禁止事项
Agent 返工触发规则
Agent 交接语言
```

## 完成标准

第三阶段完成的标志是：

```text
每个 Agent 都有明确工作协议。
每个 Agent 都知道自己不能做什么。
每个 Agent 都知道开始前需要什么输入。
每个 Agent 都知道结束时必须交付什么。
每个 Agent 都知道遇到问题应该回到哪个阶段。
```

完成第三阶段后，才适合进入第四阶段：交付记忆与复盘机制。
