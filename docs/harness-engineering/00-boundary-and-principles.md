# 00 Boundary and Principles 边界与原则

> 最后修改时间：2026-06-12 11:20:34 +08:00
> 修改人：Claude Code
> 修改的 Agent：Claude Code

## 目的

定义 Harness Engineering 的边界，防止约束模型被误写成业务功能。本文档是边界的唯一权威源。

## 定义

Harness Engineering 是约束 AI Agent 工作方式的外部工程模型。它约束 Agent 的任务执行行为，不约束业务系统必须实现什么功能。

## Harness 是什么

阶段协议、上下文约束、角色边界、工具使用纪律、人工干预规则、验收证据要求、返工路由、交付记忆规则。

## Harness 不是什么

后端模块、前端页面、数据库 schema、业务 API、产品权限系统、运行时插件、自动化测试平台。

## 约束对象

执行任务的 AI Agent：Codex、Claude Code、其他工程 Agent，以及多 Agent 协作中的协调者、实现者、验证者、评审者。不直接约束业务用户，不要求业务系统实现 Harness 能力。

## 与业务系统的关系

业务系统只能作为 Harness 的参考实例（reference 层），不能成为定义来源。Agent Cluster 的 session、runtime、capability、approval、event 等概念，只用于解释“该系统如何映射 Harness”，不得反推为对所有 Harness 使用者的要求。

## 硬规则

1. 讨论或维护 Harness 本体时，只修改协议、模板、Rubric、检查清单和说明文档，不新增业务功能。
2. 业务实现映射只能放入 reference 层文档。
3. 用户明确要求产品化之前，不把 Harness 设计成 API、模块、页面或数据库。
4. Agent 必须遵守 Harness，但不得以“使用 Harness”为理由扩大业务范围。
5. 其他文档引用边界时使用链接，不复述本文档全文。
