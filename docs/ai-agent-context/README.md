# AI 代理上下文加载索引

本文档是 Codex、Claude 以及其他 AI 工程代理的条件加载入口。

`AGENTS.md` 和 `.claude/CLAUDE.md` 只保留最高优先级规则。具体执行时，代理必须根据用户任务类型按需读取本目录文档，避免把所有永久记忆都塞进入口文件。

## 加载原则

- 先判断用户意图，再加载上下文。
- 用户明确说“只询问”“只讨论”“不要写代码”时，只加载分析所需文档，不编辑文件。
- 不确定任务落点时，先读 `project-map.md`，不要直接实现。
- 涉及 Harness Engineering 时，先读 `harness-engineering-protocol.md`，再按需读取 `docs/harness-engineering/` 下的详细规范。
- 涉及具体模块时，只读取项目地图中对应区域和相关文件。
- 不要因为文档存在就全部读取；上下文必须和当前任务相关。

## 条件加载表

| 用户任务类型 | 必读文档 | 视情况加载 |
| --- | --- | --- |
| 任意需求、功能、修复、重构 | `project-map.md`, `harness-engineering-protocol.md` | 相关代码区、测试、合同文档 |
| 只询问 Harness Engineering | `harness-engineering-protocol.md` | `docs/harness-engineering/README.md` |
| Claude/Codex 工作流维护 | `tool-workflow-rules.md`, `harness-engineering-protocol.md` | `.claude/CLAUDE.md`, `AGENTS.md` |
| 后端 API、会话、编排、运行时 | `project-map.md` | `docs/contracts/api-contract-v0.1.md`, `docs/contracts/runtime-contract-v0.1.md` |
| 前端页面、交互、状态展示 | `project-map.md` | `docs/design/ui-style-guide-v1.md`, `docs/contracts/ui-state-contract-v0.1.md` |
| 共享类型、事件、数据合同 | `project-map.md` | `docs/contracts/README.md`, `packages/shared/src/contracts.ts` |
| 测试、验收、质量闭环 | `project-map.md` | `docs/quality/`, `tests/e2e/`, `tests/harness-engineering/` |
| 本地开发、CI、部署、运维 | `project-map.md` | `docs/devops/`, `.github/workflows/ci.yml` |
| 产品范围、功能状态、计划 | `project-map.md` | `docs/product/agent-cluster-prd-v1.md`, `docs/analysis/feature-inventory-and-status-v1.md`, `docs/roadmap/remediation-plan-v1.md` |

## 推荐读取顺序

对于普通实现类任务：

```text
1. AGENTS.md 或 .claude/CLAUDE.md
2. docs/ai-agent-context/README.md
3. docs/ai-agent-context/project-map.md
4. docs/ai-agent-context/harness-engineering-protocol.md
5. 项目地图指向的具体代码、合同、测试或设计文档
```

对于只讨论或只询问任务：

```text
1. AGENTS.md 或 .claude/CLAUDE.md
2. docs/ai-agent-context/README.md
3. 与问题相关的最小文档集合
```

## 输出要求

代理最终回复必须说明：

- 当前任务实际加载了哪些关键上下文。
- 是否进入实现。
- 如果进入实现，修改了哪里、如何验证。
- 如果没有实现，给出分析结论和下一步建议。

