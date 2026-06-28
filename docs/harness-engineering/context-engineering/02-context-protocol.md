# 02 Context Protocol 上下文协议

> 最后修改时间：2026-06-12 11:20:34 +08:00
> 修改人：Claude Code
> 修改的 Agent：Claude Code

## 目的

规定每个阶段的 Agent 应该看到什么、不应该看到什么。

上下文不是越多越好。Harness Engineering 的核心职责之一，是让 Agent 在正确阶段获得正确上下文。

## 参与角色

- Requirement Agent
- Architect Agent
- Coordinator Agent
- Implementation Agent
- Verification Agent
- Review Agent
- Delivery Agent

## 上下文条目模型

每条进入阶段的上下文按两个维度标注：

来源（source）：

- user：用户输入与用户确认。
- project：项目事实，包括代码、合同、文档、测试。
- tool：工具观察结果，包括命令输出、测试结果、检索结果。
- memory：交付记忆与历史产物。
- inference：Agent 推断、假设、未确认想法。

状态（state）：

- active：可作为当前决策依据。
- stale：已过期，不得作为决策依据。
- conflict：与其他条目冲突，处理前不得使用。

`inference` 来源的条目默认不可作为验收依据，除非被 `user` 确认或 `tool` 验证。

## 上下文生命周期

```text
collect -> filter -> bind_to_stage -> use -> verify -> retain / drop / stale
```

- collect：只从允许的来源收集。
- filter：裁剪到当前阶段最小必要集合。
- bind_to_stage：与阶段产物绑定，可追溯。
- verify：进入下一阶段前核对状态标注。
- retain / drop / stale：阶段结束时决定保留、丢弃或标记过期。

## 上下文污染处理

| 污染类型 | 处理 |
| --- | --- |
| 冲突（conflict） | 当前阶段重建 Context，必要时升级人工确认 |
| 过期（stale） | 标记 stale，不作为决策依据 |
| 范围诱导 | 回到 Requirement 或 Design 确认 |
| 噪音过载 | 裁剪到当前阶段最小必要上下文 |

## 阶段入口检查

进入任一阶段前回答三问：

1. 本阶段的决策依据来自哪些来源（source）？
2. 是否存在未处理的 conflict 或 stale 条目？
3. 是否已裁剪与本阶段无关的上下文？

## 阶段上下文

### Requirement

应该看到：

- 用户原始需求
- 历史偏好
- 产品目标

不应该看到：

- 无关实现细节
- 未确认的技术方案

### Design

应该看到：

- Intent Contract
- 项目架构说明
- 相关契约
- 相关代码路径
- 已知风险

不应该看到：

- 无关模块全文
- 与本需求无关的历史会话噪音

### Planning

应该看到：

- Intent Contract
- Design Plan
- Agent 角色边界
- 工具治理规则

### Implementation

应该看到：

- Task Plan
- Design Plan
- 允许修改范围
- 工具权限
- 验收标准

不应该看到：

- 与任务无关的上下文
- 可诱导扩大范围的未确认想法

### Verification

应该看到：

- Intent Contract
- Design Plan
- Implementation Summary
- 已完成产物
- 需要验证的验收标准

### Review

应该看到：

- 全过程阶段产物
- 交接记录
- 返工记录
- 人工确认记录

### Delivery

应该看到：

- 全部阶段产物
- Review 结论
- 剩余风险
- 需要沉淀的经验

## 退出条件

- 当前阶段上下文足以完成该阶段任务。
- 上下文没有明显越界。
- 上下文条目已按来源（source）和状态（state）标注，inference 条目未被当作事实使用。

## 返工条件

- Agent 因上下文不足无法推进。
- Agent 拿到无关上下文导致范围扩大。
- 评审发现阶段产物引用了未提供或未确认的信息。

## 返工信号入口

本节定义当反馈循环（`../feedback-loop/07-feedback-loop.md`）触发返工时，上下文协议如何接收信号并重组上下文。对应闭环模型中的边 ③（Feedback → Context）。

### 返工信号字段

来自 Feedback 的返工信号必须携带以下字段：

- `回退目标阶段`：Requirement / Design / Planning / Implementation 之一
- `失败分类`：来自 `../feedback-loop/07-feedback-loop.md` 的分类
- `证据`：评审或验证发现的具体问题
- `上下文缺口`：缺失或越界的上下文项

### 重组规则

收到返工信号后，按回退目标阶段重组上下文，**不复用上一次失败时的同一份上下文**：

- 回退到 Requirement：补充用户原始需求中遗漏的目标、约束、待确认问题；移除已被否定的假设。
- 回退到 Design：补充影响范围、相关契约、被忽略的代码路径；标注本次设计需重新审视的取舍。
- 回退到 Planning：补充任务依赖、允许范围说明；移除已被验证不可行的任务定义。
- 回退到 Implementation：补充缺失的允许范围、工具权限、验收标准；标注上一次实现中越界的部分。

### 重组后的退出条件

- 上下文缺口字段中列出的项已被补齐。
- 上一次失败的证据可以在新上下文中被定位、判断或反驳。
- 重组动作被记录，可被后续 Governance 检测（对应边 ⑥）。
