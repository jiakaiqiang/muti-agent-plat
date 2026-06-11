# 12 Continuous Governance 第五阶段持续治理与演进

> 最后修改时间：2026-06-11 14:47:47 +08:00
> 修改人：Codex
> 修改的 Agent：Codex

## 目的

第五阶段不是写代码，不是新增系统功能，也不是做自动化检查平台。

第五阶段的目标是：

```text
建立 Harness Engineering 的持续治理机制，
让规程、Agent 行为、上下文、工具治理、交付记忆能够长期保持有效。
```

第一阶段定义规程。

第二阶段对齐现有协作流程。

第三阶段固化 Agent 工作协议。

第四阶段建立交付记忆与复盘机制。

第五阶段解决：

```text
这些规程如何长期不失效、不漂移、不被绕过。
```

## 第五阶段要解决的问题

如果没有持续治理，Harness Engineering 会逐渐退化：

```text
Agent 开始越权
上下文越来越臃肿
需求契约变成形式化模板
工具治理被绕过
人工确认只剩口头确认
返工分类越来越模糊
交付记忆越来越脏
旧规程不再适合新项目状态
```

第五阶段要建立一套定期复查和演进规则。

## 治理对象

持续治理覆盖 8 个对象：

```text
1. Intent Contract 质量
2. Context Protocol 执行情况
3. Agent Role 边界
4. Stage Workflow 交接纪律
5. Tool Governance 执行情况
6. Human Intervention 记录质量
7. Feedback Loop 返工质量
8. Delivery Memory 质量
```

## 治理节奏

建议分三种节奏：

### 每次交付后

检查：

```text
本次是否按规程完成？
是否出现越权？
是否出现上下文不足或过载？
是否有未记录的人工确认？
是否有返工但没有分类？
是否有应沉淀但未沉淀的经验？
```

### 每周或每批次

检查：

```text
最近多次交付是否重复出现同类问题？
哪些 Agent 最容易越权？
哪些阶段最容易返工？
哪些上下文经常缺失？
哪些规程最难执行？
```

### 每月或版本节点

检查：

```text
规程是否过期？
Agent 工作协议是否需要更新？
交付记忆是否污染？
工具治理是否仍符合风险边界？
是否需要增加、合并或删除规程？
```

## 治理维度

### 1. Intent Contract 质量

检查问题：

```text
需求契约是否清楚？
验收标准是否可判断？
非目标是否明确？
风险是否被识别？
待确认问题是否被处理？
```

常见漂移：

```text
需求契约变成一句话摘要
验收标准变成主观描述
非目标缺失
风险缺失
待确认问题被跳过
```

治理动作：

```text
更新 Intent Contract 规程
补充示例
调整 Requirement Agent 工作协议
```

### 2. Context Protocol 执行情况

检查问题：

```text
Agent 是否拿到了正确上下文？
是否拿到了过多无关上下文？
是否缺少关键上游产物？
是否混入未确认信息？
```

常见漂移：

```text
上下文越来越多
Agent 看到与当前阶段无关的信息
阶段之间事实与假设混在一起
Review 看不到全过程产物
```

治理动作：

```text
收紧上下文边界
补充不同阶段上下文样例
更新 Agent 工作协议中的输入要求
```

### 3. Agent Role 边界

检查问题：

```text
Requirement Agent 是否开始设计？
Architect Agent 是否直接实现？
Implementation Agent 是否扩大范围？
Verification Agent 是否主导需求变更？
Review Agent 是否独立判断？
Delivery Agent 是否遗漏交付记忆？
```

常见漂移：

```text
Agent 为了推进流程而越权
Coordinator 替代 Review 决策
Implementation 顺手修设计
Delivery 只做总结不做记忆沉淀
```

治理动作：

```text
更新 Agent 工作协议
补充越权示例
明确越权后的返工路径
```

### 4. Stage Workflow 交接纪律

检查问题：

```text
阶段是否跳过？
阶段产物是否完整？
下游是否能基于上游产物继续？
交接是否依赖聊天记录而非结构化产物？
```

常见漂移：

```text
没有完整需求契约就进入设计
没有设计方案就开始实现
Review 输入不完整
Delivery 无法追溯全过程
```

治理动作：

```text
更新阶段准入条件
补充交接清单
强化 Review 对交接产物的检查
```

### 5. Tool Governance 执行情况

检查问题：

```text
工具使用是否留痕？
高风险动作是否确认？
越界动作是否停止？
外部调用是否被明确批准？
```

常见漂移：

```text
中风险动作无记录
高风险动作被包装成普通动作
真实外部调用没有确认
工具权限不足时 Agent 自行绕过
```

治理动作：

```text
更新风险分级
补充工具使用示例
明确哪些动作必须进入 Human Intervention
```

### 6. Human Intervention 记录质量

检查问题：

```text
人工确认是否记录原因？
是否记录选择？
是否记录确认后回到哪个阶段？
是否把口头确认误当成长期偏好？
```

常见漂移：

```text
只写“用户已确认”
没有确认选项和理由
确认内容和后续阶段脱节
临时选择被沉淀为长期偏好
```

治理动作：

```text
更新人工干预记录格式
明确哪些确认可进入 Delivery Memory
```

### 7. Feedback Loop 返工质量

检查问题：

```text
返工是否分类？
目标阶段是否正确？
是否存在原地修复跨阶段问题？
是否重复返工不收敛？
```

常见漂移：

```text
所有失败都回 Implementation
需求问题被当成实现问题
设计问题靠实现绕过
连续返工没有升级人工确认
```

治理动作：

```text
更新返工路由表
补充失败分类样例
更新 Review Agent 工作协议
```

### 8. Delivery Memory 质量

检查问题：

```text
长期记忆是否可复用？
是否写入一次性噪音？
是否重复？
是否过期？
是否污染后续 Agent 判断？
```

常见漂移：

```text
所有交付日志都被写成记忆
一次性路径变成长期知识
旧结论没有 stale 标记
用户临时选择变成默认偏好
```

治理动作：

```text
标记 stale / superseded
合并重复记忆
删除或降级噪音
更新 Delivery Memory 写入规则
```

## 治理产物

第五阶段建议形成这些工程产物：

```text
docs/harness-engineering/governance/
  delivery-review-checklist.md
  weekly-governance-review.md
  monthly-governance-review.md
  agent-behavior-drift-checklist.md
  context-drift-checklist.md
  memory-quality-review.md
  rule-change-log.md
```

这些仍然是工程治理文件，不是代码、不是测试、不是系统功能。

## 规程变更规则

Harness Engineering 规程可以演进，但不能随意改。

每次规程变更必须说明：

```text
为什么改
影响哪些 Agent
影响哪些阶段
是否影响已有交付记忆
是否需要更新 Agent 工作协议
是否需要更新模板
```

规程变更记录建议包含：

```text
变更日期
变更原因
变更前规则
变更后规则
影响范围
迁移建议
```

## 治理决策类型

治理评审可以给出以下结论：

```text
keep        规程继续有效
adjust      规程需要小幅调整
split       规程过大，需要拆分
merge       规程重复，需要合并
deprecate   规程过期，需要废弃
escalate    问题严重，需要人工决策
```

## 第五阶段不做什么

第五阶段不做：

```text
不写自动治理程序
不新增系统功能
不新增测试平台
不把治理变成打分表演
不追求一次性完美规程
```

第五阶段只做：

```text
规程复查
行为漂移识别
上下文漂移识别
工具治理复查
交付记忆质量复查
规程变更记录
持续演进
```

## 完成标准

第五阶段完成的标志是：

```text
有固定治理节奏。
有明确治理对象。
有行为漂移检查方式。
有交付记忆质量复查方式。
有规程变更记录方式。
规程能根据真实交付经验持续演进。
```

完成第五阶段后，Harness Engineering 不再只是一次性文档，而是一套可长期维护的 Agent 工程协作体系。
