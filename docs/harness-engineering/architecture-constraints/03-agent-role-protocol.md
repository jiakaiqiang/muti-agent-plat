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

## 架构边界责任

所有角色共同遵守本次任务的 Architecture Constraints（产出与转换见 [04-stage-workflow.md](./04-stage-workflow.md)）：

- Architect Agent 负责产出架构约束。
- Coordinator Agent 把约束转换为 `allowedPaths` / `forbiddenPaths`。
- Implementation Agent 不得以“顺手修”绕过架构约束；发现约束本身有误时走 `architecture_signal` 返工，不原地改设计。
- Review Agent 检查交付是否破坏架构不变量。

## 硬规则

- Agent 不能越权。
- 发现上游问题必须通过 Feedback Loop 回退。
- 需求变更只能回到 Requirement 阶段。
- 设计变更只能回到 Design 阶段。
- 实现阶段不能自行扩大任务范围。

## 边界违规信号入口

本节定义当反馈循环（`../feedback-loop/07-feedback-loop.md`）发现 Agent 越权、产物违规或工具误用时，Architecture 控制面如何接收信号并演化边界。对应闭环模型中的边 ④（Feedback → Architecture）。

### 接收字段

来自 Feedback 的边界违规信号必须携带：

- `失败分类`：架构或边界错误 / 任务拆解错误 / 实现越界 / 工具误用
- `待修正产物`：哪个阶段的哪个产物违反了边界
- `证据`：评审或验证发现的具体违规点
- `期望修正结果`：违规如何被纠正

### 响应分级

按违规性质分三级，**不在同一通道处理**：

- 一级 单次违规：本次任务内修复，不改边界规则。由 Implementation Agent 或 Coordinator Agent 在当前阶段闭环。
- 二级 临时调整：本次任务需临时放宽或收紧边界，必须通过 Human Intervention（`../feedback-loop/06-human-intervention.md`）确认，且不写入本文件的长期规则。
- 三级 系统性违规：同一类违规在多次任务中复现，作为边界规则演化候选，沉淀进 Delivery Memory（边 ⑤），由 Continuous Governance（`../entropy-management/12-continuous-governance.md`）决定是否回写本文件。

### 硬规则

- 本文件的"角色边界"和"标准命名表"的长期修改只能由 12 Governance 的回写动作触发（边 ⑦），不允许在单次任务中直接修改。
- 单次违规修复必须保留记录，供 Governance 检测系统性违规。
- 工具误用的边界调整必须同步更新 `05-tool-governance.md` 与 `capability-binding/`，不允许只改本文件。
