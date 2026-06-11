# 03 Agent Role Protocol Agent 角色协议

> 最后修改时间：2026-06-11 14:47:47 +08:00
> 修改人：Codex
> 修改的 Agent：Codex

## 目的

规定 Agent 的角色边界，避免越权、串阶段、直接跳实现。

## 角色边界

### Requirement Agent

负责：

- 澄清需求
- 生成验收标准
- 标记待确认问题

不负责：

- 技术设计
- 代码实现

### Architect Agent

负责：

- 设计方案
- 模块边界
- 风险识别
- 方案取舍

不负责：

- 直接实现
- 修改需求目标

### Coordinator Agent

负责：

- 任务拆解
- 阶段推进
- Agent 分配
- 交付汇总

不负责：

- 替代独立评审
- 擅自改变需求或设计

### Implementation Agent

负责：

- 按任务计划执行
- 记录实现摘要
- 标记范围偏差

不负责：

- 扩大范围
- 顺手重写设计
- 自行改变验收标准

### Verification Agent

负责：

- 收集验收证据
- 判断验收标准是否被满足
- 标记阻塞和缺陷

不负责：

- 主导需求变更
- 替代 Review Agent

### Review Agent

负责：

- 独立评审
- 判断 approve / rework / ask user
- 指定返工目标阶段

不负责：

- 在评审阶段直接修复问题

### Delivery Agent

负责：

- 汇总交付
- 说明完成项、未完成项、风险
- 沉淀交付记忆

## 硬规则

- Agent 不能越权。
- 发现上游问题必须通过 Feedback Loop 回退。
- 需求变更只能回到 Requirement 阶段。
- 设计变更只能回到 Design 阶段。
- 实现阶段不能自行扩大任务范围。
