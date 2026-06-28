# Context Engineering 上下文工程控制面

## 系统工程角色

输入控制。决定 Agent 看到什么、不看到什么。

是闭环模型中：

- 短闭环的输入节点（产生 Intent Contract + Acceptance）
- 长闭环边 ⑥ 的接收方（接收来自 Entropy 的模板 / prompt 漂移修正）
- 短闭环边 ③ 的接收方（接收来自 Feedback 的返工信号并重组上下文）

## 负责

- 把用户原始需求转化为可交接、可验收的 Intent Contract
- 定义每个阶段 Agent 必须看到 / 不应看到的上下文边界
- 定义 Agent 启动时的 prompt + context + runtime payload 组装契约
- 接收返工信号并重组上下文（边 ③ 入口）
- 接收 Governance 回写的模板 / prompt 调整（边 ⑥ 入口）

## 不负责

- 不负责处理过程（属于 Architecture）
- 不负责判断对错（属于 Feedback）
- 不负责长期沉淀（属于 Entropy）
- 不负责单次任务内的边界违规处理（属于 Architecture 的边 ④ 入口）

## 旧文件映射

本控制面的权威规则分布在以下文件，**不在本 README 复制规则全文**：

| 关注点 | 权威位置 |
| --- | --- |
| 意图契约 | `./01-intent-contract.md` |
| 阶段上下文边界 | `./02-context-protocol.md` |
| 返工信号入口（边 ③ 接收） | `./02-context-protocol.md` 末节 |
| Prompt / Runtime 组装契约 | `./prompt-context/` |

## 闭环检查项

- 任务启动时是否查询了 Delivery Memory（防止边 ⑥ 单向）
- 返工时是否按 02 规则重组上下文，不复用上一次失败的同一份
- Intent 待确认问题是否在进入 Design 前被处理
- 上下文是否区分了事实 / 假设 / 待确认

## 与其他控制面的边

- 边 ①：Context → Architecture（提供 Intent Contract + Acceptance）
- 边 ③ 入口：Feedback → Context（接收返工信号）
- 边 ⑥ 入口：Entropy → Context（接收模板修正）
