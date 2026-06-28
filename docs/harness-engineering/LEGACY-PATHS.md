# Legacy Paths Map 旧路径映射表

> 在阶段 D 物理迁移后，`.claude/harness-engineering/` 下原来 12 个规程的位置发生了变化。
> 本表提供旧路径 → 新路径的映射，便于 Agent 或人工检索。
> 旧位置已不存在，所有规则文件已 `git mv` 到对应控制面目录。

## 文件级映射

| 旧路径（迁移前） | 新路径（迁移后） |
| --- | --- |
| `.claude/harness-engineering/01-intent-contract.md` | `.claude/harness-engineering/context-engineering/01-intent-contract.md` |
| `.claude/harness-engineering/02-context-protocol.md` | `.claude/harness-engineering/context-engineering/02-context-protocol.md` |
| `.claude/harness-engineering/03-agent-role-protocol.md` | `.claude/harness-engineering/architecture-constraints/03-agent-role-protocol.md` |
| `.claude/harness-engineering/04-stage-workflow.md` | `.claude/harness-engineering/architecture-constraints/04-stage-workflow.md` |
| `.claude/harness-engineering/05-tool-governance.md` | `.claude/harness-engineering/architecture-constraints/05-tool-governance.md` |
| `.claude/harness-engineering/06-human-intervention.md` | `.claude/harness-engineering/feedback-loop/06-human-intervention.md` |
| `.claude/harness-engineering/07-feedback-loop.md` | `.claude/harness-engineering/feedback-loop/07-feedback-loop.md` |
| `.claude/harness-engineering/08-delivery-memory.md` | `.claude/harness-engineering/entropy-management/08-delivery-memory.md` |
| `.claude/harness-engineering/09-phase-two-alignment.md` | `.claude/harness-engineering/legacy/09-phase-two-alignment.md` |
| `.claude/harness-engineering/10-agent-working-protocol.md` | `.claude/harness-engineering/architecture-constraints/10-agent-working-protocol.md` |
| `.claude/harness-engineering/11-delivery-memory-practice.md` | `.claude/harness-engineering/entropy-management/11-delivery-memory-practice.md` |
| `.claude/harness-engineering/12-continuous-governance.md` | `.claude/harness-engineering/entropy-management/12-continuous-governance.md` |

## 子目录级映射

| 旧路径 | 新路径 |
| --- | --- |
| `.claude/harness-engineering/prompt-context/` | `.claude/harness-engineering/context-engineering/prompt-context/` |
| `.claude/harness-engineering/capability-binding/` | `.claude/harness-engineering/architecture-constraints/capability-binding/` |
| `.claude/harness-engineering/delivery-memory/` | `.claude/harness-engineering/entropy-management/delivery-memory/` |
| `.claude/harness-engineering/alignment/` | 不变（跨控制面运行时映射层） |

## 模板拆分

旧的统一 `.claude/harness-engineering/templates/` 目录已按控制面拆分：

| 模板 | 新位置 | 所属控制面 |
| --- | --- | --- |
| `intent-contract-template.md` | `context-engineering/templates/` | Context Engineering |
| `design-plan-template.md` | `architecture-constraints/templates/` | Architecture Constraints |
| `task-plan-template.md` | `architecture-constraints/templates/` | Architecture Constraints |
| `implementation-summary-template.md` | `architecture-constraints/templates/` | Architecture Constraints |
| `verification-result-template.md` | `feedback-loop/templates/` | Feedback Loop |
| `review-report-template.md` | `feedback-loop/templates/` | Feedback Loop |
| `final-delivery-template.md` | `entropy-management/templates/` | Entropy Management |

## 新增控制面入口

每个控制面目录下有一个 `README.md`，作为该控制面的职责定义与旧文件指针：

- [context-engineering/README.md](./context-engineering/README.md)
- [architecture-constraints/README.md](./architecture-constraints/README.md)
- [feedback-loop/README.md](./feedback-loop/README.md)
- [entropy-management/README.md](./entropy-management/README.md)

## 为什么迁移

物理迁移是改进计划阶段 D 的执行。旧的"按编号顺序排列"组织方式把 8 个规程当作时间顺序的阶段，掩盖了系统工程意义上的"四个控制面"。迁移后：

- 编辑某个控制面时，相关文件全部在同一目录
- 跨控制面的引用要走 `../`，能立刻看出耦合关系
- 长期规则的归属一目了然

完整改造原则见 [`harness-engineering-improvement-plan.html`](./harness-engineering-improvement-plan.html)。

## 注意

- 历史文档 09 移入 `legacy/`，仅供引用，不再作为活规程。
- `alignment/` 不归入任何控制面，是运行时实现到四控制面的映射层。
- `harness-engineering-improvement-plan.html` 留在根目录，作为改造方案档案。
