# Feedback Loop 反馈循环控制面

## 系统工程角色

误差控制。决定输出对不对、错了怎么回。

是闭环模型中：

- 短闭环的误差节点（验证 + 评审 + 人工介入）
- 短闭环边 ③ ④ 的出口（向 Context / Architecture 发送返工信号）
- 边 ⑤ 的出口（向 Entropy 发送沉淀候选）
- 长闭环边 ⑧ 的接收方（接收 Entropy 的新失败分类 / 人工介入触发）

## 负责

- 验证证据收集与验收标准判定
- 独立评审与 approve / rework / ask_user / fail 决策
- 失败分类与返工路由
- 人工介入触发条件与确认记录
- 对外信号契约：返工信号字段映射、信号去向规则
- 接收 Governance 回写的新分类与新触发条件（边 ⑧ 入口）

## 不负责

- 不负责需求变更本身（必须回 Context）
- 不负责设计变更本身（必须回 Architecture）
- 不负责直接修复（评审阶段禁止）
- 不负责长期沉淀（移交 Entropy）

## 旧文件映射

| 关注点 | 权威位置 |
| --- | --- |
| 人工介入触发与记录 | `./06-human-intervention.md` |
| 失败分类与返工路由 | `./07-feedback-loop.md` |
| 返工信号对外契约（边 ③ ④ ⑤ 出口） | `./07-feedback-loop.md` 末节 |
| 验证结果模板 | `./templates/verification-result-template.md` |
| 评审报告模板 | `./templates/review-report-template.md` |
| ExecutionOutcome 状态机 | `../alignment/orchestrator-alignment.md` |

## 闭环检查项

- 每次返工是否都填齐了对外信号字段（缺字段不得对外发出）
- 一次返工只回一个目标阶段（不允许同时多阶段）
- 连续 3 次返工未收敛是否升级到 Human Intervention
- 任意返工是否都触发了 Entropy 沉淀候选（边 ⑤ 强制）

## 与其他控制面的边

- 边 ②：Architecture → Feedback（接收 Implementation Summary）
- 边 ③ 出口：Feedback → Context（返工信号）
- 边 ④ 出口：Feedback → Architecture（边界违规信号）
- 边 ⑤ 出口：Feedback → Entropy（沉淀候选）
- 边 ⑧ 入口：Entropy → Feedback（新分类 / 新触发）
