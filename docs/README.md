# Docs 目录索引

`docs/` 已按文档类型归档，新增文档时请优先放入对应分类目录，而不是继续堆在根目录。

## 分类总览

| 目录 | 内容类型 | 说明 |
| --- | --- | --- |
| `product/` | 需求文档 | 产品范围、目标、核心流程与 PRD |
| `design/` | 设计文档 | 系统设计、专题设计、UI 风格规范 |
| `implementation/` | 实施拆解 | 面向开发执行的实施拆分与交付组织 |
| `roadmap/` | 规划与修复计划 | 修复方案、执行批次、任务推进计划 |
| `analysis/` | 现状分析 | 功能盘点、项目分析、当前项目架构和问题分级 |
| `contracts/` | 合同文档 | API、事件、运行时、数据、UI 状态合同 |
| `quality/` | 质量与验收 | 验收矩阵、闭环验收报告 |
| `devops/` | 运维开发 | 本地开发、CI、发布检查 |
| `harness-engineering/` | 工程协议 | Harness Engineering 约束模型，按 core / templates / reference 三层组织 |
| `ai-agent-context/` | AI 代理上下文 | Codex/Claude 条件加载入口与项目地图 |

## 推荐阅读路径

主 Agent 主持群聊、多会话隔离与长会话治理的分阶段改造，请从 [实施总计划与 9 阶段 SDD 索引](roadmap/main-agent-collaboration-roadmap-v1.md) 开始。阶段 0 已实现[共享合同与兼容校验](contracts/main-agent-collaboration-contract-v1.md)，证据见[验收记录](quality/main-agent-collaboration-phase-0-checklist-v1.md)；其余阶段待实施，不表示新业务流程已上线。

1. 产品与目标：`product/`
2. 设计与交互：`design/`
3. 当前状态与问题：`analysis/`
4. 执行拆解与修复计划：`implementation/`、`roadmap/`
5. 验收与质量：`quality/`
6. 合同与工程协议：`contracts/`、`harness-engineering/`

当前架构入口：[`analysis/project-architecture.md`](analysis/project-architecture.md)。该文档以当前代码为主，说明 Web、Desktop、Server、Runtime、Context v2、Workspace、事件流和持久化之间的关系。

本专题“群聊方案文件化修订”按 SDD 四件套阅读：[Spec](product/discussion-document-revision-spec-v1.md) → [Plan](design/discussion-document-revision-plan-v1.md) → [Tasks](implementation/discussion-document-revision-tasks-v1.md) → [Checklist](quality/discussion-document-revision-checklist-v1.md)。当前主体实现、DDR-AC1～DDR-AC10 专项证据、专项 Chromium E2E、文件修订/工作流回归、隔离 PostgreSQL 恢复和测试环境 Electron 渲染均已通过；正文已收敛为工作区文档唯一来源，普通事件/Memory/Prompt 只保留引用。会话永久清理与内容对象 GC 已明确延期到独立生命周期协议，仓库级串行测试的环境清理审计另行跟进。

本专题“群聊工作流接单超时可靠性”按 SDD 四件套阅读：[Spec](product/task-acceptance-timeout-reliability-spec-v1.md) → [Plan](design/task-acceptance-timeout-reliability-plan-v1.md) → [Tasks](implementation/task-acceptance-timeout-reliability-tasks-v1.md) → [Checklist](quality/task-acceptance-timeout-reliability-checklist-v1.md)。当前代码与自动化验证已完成；真实 Claude/local_bridge 慢调用采样和生产部署观察仍延期。

本专题“会话归档管理”按 SDD 四件套阅读：[Spec](product/session-archive-management-spec-v1.md) → [Plan](design/session-archive-management-plan-v1.md) → [Tasks](implementation/session-archive-management-tasks-v1.md) → [Checklist](quality/session-archive-management-checklist-v1.md)。安全停止、归档、项目分组、恢复，以及真实 PostgreSQL 重启恢复和原生 Electron smoke 均已通过；多窗口冲突/批量操作和接入独立项目目录后的正式项目名称解析仍延期。

## 归档原则

- 产品目标和范围放入 `product/`。
- 系统设计、专题设计、风格规范放入 `design/`。
- 实施拆解、团队分工、里程碑交付放入 `implementation/`。
- 修复计划、执行批次、推进路线图放入 `roadmap/`。
- 现状盘点、分析结论、问题清单放入 `analysis/`。
- 合同、验收、运维、AI 上下文继续沿用现有目录。

## 已做的整合

- 修复方案和执行计划统一归入 `roadmap/`。
- 功能清单与项目分析统一归入 `analysis/`，作为“现状与问题”入口。
- 系统设计、工作区感知设计和 UI 风格统一归入 `design/`。
- Workspace Index First 当前补齐任务统一从 `implementation/workspace-index-first-on-demand-context-remediation-development-v1.md` 执行；原实施说明和验收报告中的“已完成”状态须以该文档退出规则复核。
