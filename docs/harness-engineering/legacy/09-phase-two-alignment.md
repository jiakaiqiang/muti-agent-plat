# 09 Phase Two Alignment 第二阶段对齐方案

> **工程化定位** · 历史归档（legacy/）· 不再演化，仅供查阅 · 第二阶段对齐结论已被四控制面架构取代

> **执行状态：未启动**
>
> 本文档约定的 8 份对齐产物（`docs/harness-engineering/alignment/*.md`）目前尚未生成。`.claude/harness-engineering/alignment/` 下现存的 6 份文件（README / artifacts / events / gap / orchestrator / session）是早期占位，与本文档要求的命名不对应，需在第二阶段正式启动时重新规整。审计依据见 `docs/harness-engineering/agent-体系审计与改进方案.md` 问题 10。

## 目的

第二阶段不是写代码，不是新增系统功能，也不是聚合测试。

第二阶段的目标是：

```text
把本项目现有的协作方式，对齐第一阶段定义的 8 个 Harness Engineering 规程。
```

也就是说，不急着改变系统，而是先改变 Agent 协作时的工程纪律。

## 第二阶段要解决的问题

当前系统已经有：

```text
用户输入
Agent 讨论
brief 生成
任务拆解
Agent 执行
post review
final delivery
```

但这些过程还容易出现：

```text
需求没有明确契约
Agent 上下文边界不清
角色可能越权
阶段交接不够结构化
工具权限只是能力开关，不是工程纪律
人工确认没有变成交付记录
返工原因不够分类
交付经验没有稳定沉淀
```

第二阶段就是把这些现有流程逐步套进第一阶段规程。

## 对齐对象

第二阶段只对齐现有协作行为，不新增系统模块。

需要对齐的对象：

| 现有过程 | 需要对齐的规程 |
| --- | --- |
| 用户输入 / brief 生成 | Intent Contract |
| Agent 讨论 / context pack | Context Protocol |
| 默认 Agent 分工 | Agent Role Protocol |
| brief -> tasks -> execution -> review -> delivery | Stage Workflow |
| capability 使用 | Tool Governance |
| 用户确认卡片 | Human Intervention |
| review / failed / waiting | Feedback Loop |
| final delivery / artifacts | Delivery Memory |

## 第二阶段执行步骤

### Step 1：对齐需求表达

现有 brief 生成过程要先按 Intent Contract 思路检查：

```text
目标是否清楚
非目标是否清楚
约束是否清楚
验收标准是否可判断
风险是否列出
待确认问题是否被标记
```

如果不满足，不应该直接进入设计或任务拆解。

第二阶段产物：

```text
docs/harness-engineering/alignment/intent-contract-alignment.md
```

内容记录：

```text
当前 brief 哪些字段已满足 Intent Contract
哪些字段缺失
哪些内容需要提示词或规程补强
```

### Step 2：对齐上下文

检查不同 Agent 当前拿到的上下文是否符合 Context Protocol。

重点看：

```text
Requirement Agent 是否拿到太多实现细节
Architect Agent 是否能看到需求契约和相关代码范围
Implementation Agent 是否只看到任务相关上下文
Review Agent 是否看到全过程产物
Delivery Agent 是否看到评审结论和剩余风险
```

第二阶段产物：

```text
docs/harness-engineering/alignment/context-alignment.md
```

内容记录：

```text
每个阶段当前上下文
应该保留的上下文
应该移除的上下文
需要补充的上下文
```

### Step 3：对齐 Agent 角色

检查默认 Agent 是否遵守角色边界。

重点看：

```text
Requirement Agent 是否开始设计
Architect Agent 是否直接实现
Coordinator Agent 是否替代 Review 判断
Implementation Agent 是否改动需求或设计
Verification Agent 是否主导需求变更
Review Agent 是否给出明确返工目标
Delivery Agent 是否只是总结而没有沉淀记忆
```

第二阶段产物：

```text
docs/harness-engineering/alignment/agent-role-alignment.md
```

### Step 4：对齐阶段交接

检查现有流程是否真的按阶段交接。

需要检查：

```text
brief 是否能作为 Requirement 阶段产物
task list 是否能作为 Planning 阶段产物
runtime result 是否能支撑 Implementation Summary
post review 是否能支撑 Review Report
final delivery 是否能支撑 Delivery Memory
```

第二阶段产物：

```text
docs/harness-engineering/alignment/stage-workflow-alignment.md
```

### Step 5：对齐工具治理

检查 capabilities 当前是否符合 Tool Governance 的工程原则。

重点看：

```text
低风险动作是否默认允许
中风险动作是否留痕
高风险动作是否人工确认
越权动作是否停止
外部发送是否仍保持草稿优先
```

第二阶段产物：

```text
docs/harness-engineering/alignment/tool-governance-alignment.md
```

### Step 6：对齐人工干预

检查当前用户确认是否只是 UI 交互，还是已经成为交付过程的一部分。

需要记录：

```text
确认原因
确认内容
确认结果
确认后回到哪个阶段
```

第二阶段产物：

```text
docs/harness-engineering/alignment/human-intervention-alignment.md
```

### Step 7：对齐反馈返工

检查失败后是否只是进入 failed/waiting，还是能说明应该回到哪个阶段。

返工分类：

```text
需求问题
设计问题
任务拆解问题
实现问题
验收证据问题
权限问题
上下文问题
```

第二阶段产物：

```text
docs/harness-engineering/alignment/feedback-loop-alignment.md
```

### Step 8：对齐交付记忆

检查 final delivery 是否只做总结，还是能沉淀经验。

需要看：

```text
能力域是否记录
涉及路径是否记录
设计决策是否记录
失败模式是否记录
有效验收方式是否记录
用户偏好是否记录
```

第二阶段产物：

```text
docs/harness-engineering/alignment/delivery-memory-alignment.md
```

## 第二阶段输出

第二阶段最终应该产出一个对齐报告：

```text
docs/harness-engineering/alignment/phase-two-alignment-report.md
```

报告结构：

```text
1. 当前流程对齐程度
2. 已符合的规程
3. 未符合的规程
4. 需要调整的 Agent 提示词
5. 需要调整的上下文选择
6. 需要调整的阶段交接
7. 需要调整的人工确认记录
8. 需要沉淀的交付记忆规则
9. 第三阶段建议
```

## 第二阶段不做什么

第二阶段不做：

```text
不新增后端模块
不新增前端页面
不设计 API
不写测试平台
不把规程固化成系统实现
```

第二阶段只做：

```text
规程对齐
提示词对齐
上下文对齐
角色边界对齐
阶段交接对齐
返工分类对齐
交付记忆对齐
```

## 完成标准

第二阶段完成的标志不是“代码跑通”，而是：

```text
本项目现有流程能被 8 个规程解释和约束。
每个阶段都知道自己输入什么、输出什么、何时继续、何时返工。
每个 Agent 都知道自己的角色边界。
每类失败都能被归类到正确返工路径。
最终交付能沉淀为项目知识。
```
