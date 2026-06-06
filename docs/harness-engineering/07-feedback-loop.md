# 07 Feedback Loop 反馈返工

## 目的

规定失败、缺陷、阻塞、权限问题出现后，如何分类并回到正确阶段。

## 返工路由

| 问题类型 | 回到阶段 |
| --- | --- |
| 需求目标不清 | Requirement |
| 验收标准不可判断 | Requirement |
| 架构或边界错误 | Design |
| 方案风险未处理 | Design |
| 任务拆解错误 | Planning |
| 任务依赖错误 | Planning |
| 实现未满足验收标准 | Implementation |
| 实现越界 | Implementation 或 Human Intervention |
| 验收证据不足 | Verification |
| 工具权限不足 | Human Intervention |
| 上下文不足或错误 | 当前阶段重建 Context |

## 返工记录

每次返工必须说明：

- 问题类型
- 触发阶段
- 目标阶段
- 需要修正的产物
- 证据
- 期望修正结果

## 硬规则

- 不能原地修复跨阶段问题。
- 不能用实现补救需求不清。
- 不能用测试结论替代评审结论。
- 连续返工不收敛时必须进入 Human Intervention。
