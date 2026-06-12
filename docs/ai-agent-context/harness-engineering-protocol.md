# Harness Engineering 执行协议

本文档定义 AI 工程代理在完成任务时如何默认使用 Harness Engineering。

## 边界原则

Harness Engineering 约束 AI 工程代理如何完成任务，不约束业务系统必须实现什么功能。完整边界见 `docs/harness-engineering/00-boundary-and-principles.md`。

用户要求整理、讨论、维护或改进 Harness 时，默认只处理：协议、模板、Rubric、Agent 工作纪律、上下文加载规则、工具使用规则、交付记忆规则。

不默认新增：后端模块、前端页面、API、数据库表、产品审批流、runtime adapter。只有用户明确要求“把某个 Harness 约束产品化”时，才进入业务实现设计。

## 默认行为

用户输入需求时，代理默认按以下顺序推进：

```text
Requirement
  -> Design
  -> Planning
  -> Implementation
  -> Verification
  -> Review
  -> Delivery
  -> Delivery Memory
```

用户不需要额外说“按 Harness Engineering 来”。

## 任务入口判断

开始前先判断用户当前意图：

- 只询问或只讨论：只做分析，不编辑文件。
- 需要实现：进入完整 Harness 流程。
- 需要 review：以 Review 阶段为主，必要时回溯 Requirement / Design。
- 需要排查：先形成问题 Intent Contract，再定位、验证和交付。
- 需要维护工具协议：优先修改 `AGENTS.md`、`.claude/CLAUDE.md` 或 `docs/ai-agent-context/`。

## 阶段约束

每个阶段进入前先回答三问（详见 `docs/harness-engineering/02-context-protocol.md`）：

1. 本阶段的决策依据来自哪些来源（user / project / tool / memory / inference）？
2. 是否存在未处理的 conflict 或 stale 上下文？
3. 是否已裁剪与本阶段无关的上下文？

### Requirement

形成 Intent Contract，至少包含：

- 目标。
- 范围。
- 非目标。
- 约束。
- 验收标准。
- 风险。
- 未决问题。

信息不足但可以安全前进时，说明假设并继续；信息不足且会导致错误实现时，先问用户。

### Design

将 Intent Contract 映射到项目地图：

- 找到受影响区域。
- 读取相关合同、设计文档、代码和测试。
- 说明设计取舍。
- 标记高风险点。
- 产出本次任务的 Architecture Constraints：允许修改范围、禁止修改范围、不变量（详见 `docs/harness-engineering/04-stage-workflow.md`）。

### Planning

形成短计划：

- 要查看什么。
- 要改什么（架构约束转换为 allowedPaths / forbiddenPaths）。
- 如何验证。
- 哪些点需要人工确认。

### Implementation

只有在用户没有禁止修改，且范围明确时才实现。

禁止事项：

- 用户说只询问时编辑文件。
- 为了“使用 Harness”而新增业务运行时代码。
- 越过范围修改无关文件。
- 未确认就执行破坏性操作或外部副作用。

### Verification

选择最小有效验证集合。

常用命令：

```bash
npm run typecheck
npm run test
npm run test:harness
npm run build
```

只改文档时，可不运行完整测试，但必须说明未运行原因。

### Review

交付前检查：

- 是否满足验收标准。
- 是否发生范围漂移。
- 是否破坏架构约束或不变量。
- 是否影响合同或共享类型。
- 是否需要补测试或补文档。

失败或返工时按 `docs/harness-engineering/07-feedback-loop.md` 的 Signal 路由分类回退；返工以闭环说明结束（修正了什么、为何问题不再存在、是否影响下游）。同一 Signal 且同一目标阶段的返工出现第 2 次时，必须停下来问用户。

### Delivery

回复应简洁说明：

- 做了什么。
- 文件位置。
- 验证结果。
- 剩余风险。

### Delivery Memory

如果产生可复用知识，应沉淀到合适文档：

- AI 工具工作方式：`docs/ai-agent-context/`
- Harness 规程：`docs/harness-engineering/`
- 产品范围：`docs/product/agent-cluster-prd-v1.md`
- 功能状态：`docs/analysis/feature-inventory-and-status-v1.md`
- 合同：`docs/contracts/`
- 运维：`docs/devops/`

不要把一次性猜测沉淀为长期规则。

## 概念产物

复杂任务可以使用这些概念产物组织工作，但不要求每次创建文件：

- `intent_contract`
- `design_plan`
- `task_plan`
- `implementation_summary`
- `verification_summary`
- `review_report`
- `final_delivery`

## 详细规范

详细 Harness 文档位于：

```text
docs/harness-engineering/
```

常用入口：

- `docs/harness-engineering/README.md`
- `docs/harness-engineering/00-boundary-and-principles.md`
- `docs/harness-engineering/01-intent-contract.md`
- `docs/harness-engineering/02-context-protocol.md`
- `docs/harness-engineering/04-stage-workflow.md`
- `docs/harness-engineering/05-tool-governance.md`
- `docs/harness-engineering/06-human-intervention.md`
- `docs/harness-engineering/07-feedback-loop.md`
- `docs/harness-engineering/08-delivery-memory.md`
- `docs/harness-engineering/10-agent-working-protocol.md`
- `docs/harness-engineering/12-continuous-governance.md`

