# Architecture Constraints 架构约束控制面

## 系统工程角色

处理控制。决定 Agent 怎么处理、产出什么形态。

是闭环模型中：

- 短闭环的处理节点（按 Agent 边界和工具治理执行）
- 长闭环边 ⑦ 的接收方（接收 Entropy 的边界 / 工具风险演化）
- 短闭环边 ④ 的接收方（接收 Feedback 的边界违规信号）

## 负责

- Agent 角色边界与标准命名表
- 阶段流转、准入条件、退出条件、交接产物清单
- 工具风险分级与执行规则
- 能力到 Agent 的绑定关系
- 产物的存储类型与工程语义（artifact / harnessArtifact）
- 接收边界违规信号并按三级响应处理（边 ④ 入口）
- 接收 Governance 回写的边界与工具调整（边 ⑦ 入口）

## 不负责

- 不负责需求澄清（属于 Context）
- 不负责判断验收是否通过（属于 Feedback）
- 不负责长期边界规则的修订（必须由 Entropy 经边 ⑦ 触发，单次任务不允许直接改边界规则）
- 不负责单次失败的失败分类（属于 Feedback）

## 旧文件映射

| 关注点 | 权威位置 |
| --- | --- |
| Agent 角色边界 + 标准命名 | `./03-agent-role-protocol.md` |
| 边界违规信号入口（边 ④ 接收） | `./03-agent-role-protocol.md` 末节 |
| 阶段顺序与交接 | `./04-stage-workflow.md` |
| 工具风险与留痕 | `./05-tool-governance.md` |
| Agent 工作协议（执行手册） | `./10-agent-working-protocol.md` |
| 能力绑定 | `./capability-binding/` |
| 产物存储与工程语义 | `../alignment/artifacts-alignment.md` |

## 闭环检查项

- 单次任务中的边界违规是否走了三级响应（一级修复 / 二级 HI 临时调整 / 三级沉淀候选）
- 工具风险等级调整是否同步改了 `05` 与 `capability-binding/`
- 阶段交接是否依赖结构化产物，而非聊天记录
- 长期边界规则的修改是否能追溯到 Governance 回写动作

## 与其他控制面的边

- 边 ①：Context → Architecture（接收 Intent Contract）
- 边 ②：Architecture → Feedback（产出 Implementation Summary）
- 边 ④ 入口：Feedback → Architecture（接收边界违规信号）
- 边 ⑦ 入口：Entropy → Architecture（接收边界 / 工具演化回写）
