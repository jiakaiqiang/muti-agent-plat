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
