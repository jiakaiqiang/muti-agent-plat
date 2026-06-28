# 07 Feedback Loop 反馈返工

> 最后修改时间：2026-06-11 14:47:47 +08:00
> 修改人：Codex
> 修改的 Agent：Codex

## 目的

规定失败、缺陷、阻塞、权限问题出现后，如何分类并回到正确阶段。

## 返工路由

| Signal | 问题类型 | 回到阶段 |
| --- | --- | --- |
| requirement_signal | 需求目标不清 | Requirement |
| requirement_signal | 验收标准不可判断 | Requirement |
| architecture_signal | 架构或边界错误 | Design |
| architecture_signal | 方案风险未处理 | Design |
| planning_signal | 任务拆解错误 | Planning |
| planning_signal | 任务依赖错误 | Planning |
| implementation_signal | 实现未满足验收标准 | Implementation |
| role_boundary_signal | 实现越界 | Implementation 或 Human Intervention |
| verification_signal | 验收证据不足 | Verification |
| tool_signal | 工具权限不足 | Human Intervention |
| context_signal | 上下文不足或错误 | 当前阶段重建 Context |
| memory_signal | 交付记忆污染或误导 | 修正记忆 + 当前阶段重建 Context |
| entropy_signal | 范围膨胀、规则冲突、文档漂移 | Design 或 Human Intervention |

## 返工记录

每次返工必须说明：

- 问题类型
- 触发阶段
- 目标阶段
- 需要修正的产物
- 证据
- 期望修正结果

## 闭环标准

返工不以“重新提交”结束，以闭环说明结束。闭环必须包含：

1. 哪个上游产物被修正。
2. 修正后的产物位置。
3. 为什么原问题不再存在。
4. 是否影响下游阶段。
5. 是否需要重新验证或重新评审。
6. 本次路由是否正确；路由错误记入 `12-continuous-governance.md` 治理复盘。

## 硬规则

- 不能原地修复跨阶段问题。
- 不能用实现补救需求不清。
- 不能用测试结论替代评审结论。
- 同一 Signal 且同一目标阶段的返工出现第 2 次时，必须进入 Human Intervention，不得第 3 次自行返工。

## 返工信号对外契约

本节定义返工记录如何作为信号发送给下游控制面。对应闭环模型中的边 ③（Feedback → Context）、边 ④（Feedback → Architecture）、边 ⑤（Feedback → Entropy）。

### 字段映射

返工记录在对外发送时使用统一字段名，与 `../context-engineering/02-context-protocol.md` 的返工信号入口对齐：

| 07 记录字段 | 对外信号字段 | 消费方 |
| --- | --- | --- |
| 问题类型 | 失败分类 | Context / Entropy |
| 目标阶段 | 回退目标阶段 | Context |
| 证据 | 证据 | Context / Architecture |
| 上下文缺口 | 上下文缺口 | Context |
| 需要修正的产物 | 待修正产物 | Architecture |
| 期望修正结果 | 期望修正结果 | Context / Architecture |

### 信号去向

- 失败分类为 `需求目标不清` / `验收标准不可判断` / `上下文不足或错误`：信号发往 Context（边 ③）。
- 失败分类为 `架构或边界错误` / `任务拆解错误` / `实现越界`：信号同时发往 Context 与 Architecture（边 ③ + 边 ④）。
- 任意返工：必须沉淀进 Delivery Memory（边 ⑤），由 `../entropy-management/08-delivery-memory.md` 接收。

### 硬规则

- 一次返工只允许一个目标阶段，不允许同时回退到多个阶段。
- 返工记录不得跳过对外信号字段，缺字段时不得对外发出。
- 同一问题在 3 次返工内未收敛，必须进入 Human Intervention，不得继续走 Feedback 循环。
