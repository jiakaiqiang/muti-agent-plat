# 02 Context Protocol 上下文协议

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
- 上下文中区分了事实、假设和待确认问题。

## 返工条件

- Agent 因上下文不足无法推进。
- Agent 拿到无关上下文导致范围扩大。
- 评审发现阶段产物引用了未提供或未确认的信息。
