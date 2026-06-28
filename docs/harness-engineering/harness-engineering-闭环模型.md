# Harness Engineering 系统工程闭环模型

> 本文档把 Harness Engineering 的四个改进方向（上下文工程、架构约束、反馈循环、熵管理）建模为一个具备闭环能力的工程系统，定义短闭环（单次任务内）与长闭环（跨任务演化）的信号流动、断点与可观测状态量。
>
> 范围：`.claude/harness-engineering/` 规程的演化基线。不取代具体规程文件，作为后续按落地次序对齐规程时的参照模型。
>
> 状态：草案 · 待按落地次序逐步对齐到具体规程。
>
> 日期：2026-06-27

## 一、四控制面的系统工程角色

把四个改进方向翻译为系统工程的标准语言，闭环位置即清晰。

| 控制面 | 系统工程角色 | 性质 |
| --- | --- | --- |
| 上下文工程 Context Engineering | 输入控制 | 决定 Agent 看到什么 |
| 架构约束 Architecture Constraints | 处理控制 | 决定 Agent 怎么处理、产出什么形态 |
| 反馈循环 Feedback Loop | 误差控制 | 决定输出对不对、错了怎么回 |
| 熵管理 Entropy Management | 演化控制 | 决定系统本身怎么自我修正 |

关键判断：**熵管理是唯一具备"回写"能力的控制面**，其他三个被驱动。这是闭环成立的前提。如果熵管理只沉淀不回写，长闭环退化为单向流水线。

## 二、两个闭环（缺一不可）

### 2.1 短闭环：单次任务内（artifact 驱动）

```text
Intent (Context Engineering)
  ↓ 提供 acceptance + scope
Agent Boundary + Tool Risk (Architecture Constraints)
  ↓ 产出 implementation summary
Verification + Review (Feedback Loop)
  ├─ pass → Final Delivery
  └─ fail → 决定回到哪个阶段 → 重组 Context → 再来一轮
```

特征：

- 信号载体：artifact（intent contract、design plan、implementation summary、verification result、review report）
- 循环周期：一次交付
- 闭环开关：Verification / Review 的 `回退目标阶段` 字段

### 2.2 长闭环：跨任务演化（memory 驱动）

```text
每次交付 → Delivery Memory 沉淀
    ↓
Continuous Governance 定期检测漂移
    ↓ 检测出模式
    ├─→ 回写 Context（intent 模板、prompt 漂移修正）
    ├─→ 回写 Architecture（Agent 边界、工具风险等级）
    └─→ 回写 Feedback（新的失败分类、新的人工介入触发）
```

特征：

- 信号载体：memory entry（项目知识、设计决策、失败模式、验收经验、用户偏好）
- 循环周期：多次交付
- 闭环开关：Continuous Governance 的回写动作清单

## 三、闭环上的 8 条边（信号通路）

闭环成立 ＝ 这 8 条边都通畅。任何一条断了，闭环就退化成单向流水线。

| 边 | 来源 | 去向 | 信号载体 | 所属闭环 |
| --- | --- | --- | --- | --- |
| ① | Context | Architecture | Intent Contract + Acceptance | 短 |
| ② | Architecture | Feedback | Implementation Summary + 产物链 | 短 |
| ③ | Feedback | Context | 返工触发 → 重组上下文 | 短 |
| ④ | Feedback | Architecture | 边界违规 → 边界调整建议 | 短 |
| ⑤ | Feedback | Entropy | 失败分类 → 沉淀 | 短→长 |
| ⑥ | Entropy | Context | 模板 / prompt 漂移修正 | 长 |
| ⑦ | Entropy | Architecture | 工具风险 / Agent 边界演化 | 长 |
| ⑧ | Entropy | Feedback | 新返工分类、新人工介入条件 | 长 |

### 3.1 现状缺哪些边（基于现有文档判定）

- ⑥⑦⑧ 在文档里均未明确"如何回写"：`12-continuous-governance.md` 检测出问题后回到哪里、用什么形式、由谁执行，三处皆空白。
- ③ 在 `07-feedback-loop.md` 中有失败分类，但 `02-context-protocol.md` 没有对应的"接收返工信号、重组上下文"入口。
- ② 实际存在，但 `04-stage-workflow.md` 中没显式定义"交接产物 → 反馈输入"的字段对齐。

## 四、四个常见断点

闭环结构搭得起来，但容易在以下四处断开：

1. **Verification 不回写 Context** — 验证发现"上下文缺失"，但 `02` 没有补丁机制，下一次仍会发生。
2. **Delivery Memory 写而不查** — 沉淀了五类记忆，但下次任务启动时无人读取。需要在 Context 组装阶段强制查询 Memory。
3. **Governance 检测而不修** — 漂移检查发现问题，但没有"回写到 01-08"的执行路径。
4. **Capability Binding 与 Tool Governance 脱钩** — `05` 升级工具风险等级后，`capability-binding/` 未同步。

## 五、闭环的触发器与状态量

每个控制面需要可观测的状态量，否则就是"声称形成了闭环但无法证明"。

| 控制面 | 触发器 | 可度量状态量 |
| --- | --- | --- |
| Context | 任务启动 / 返工请求 | Intent 覆盖率、待确认项数、Context 完整度 |
| Architecture | 阶段交接 | 越权事件数、工具误用数、产物缺失率 |
| Feedback | 验证完成 / 评审完成 | 返工率、人工介入率、阻塞率、平均返工跳数 |
| Entropy | 交付完成（写）/ 定时（清）/ 漂移检测（修） | 记忆条目数、漂移命中数、过期清理数、回写动作数 |

核心指标：**回写动作数**（Entropy → 其他三面的回写次数）。长期为零等于长闭环没成立。

## 六、12 规程到闭环的映射

| 闭环位置 | 现有规程 |
| --- | --- |
| 短闭环 - 输入 | `01-intent-contract` / `02-context-protocol` / `prompt-context/` |
| 短闭环 - 处理 | `03-agent-role-protocol` / `04-stage-workflow` / `05-tool-governance` / `capability-binding/` |
| 短闭环 - 误差 | `06-human-intervention` / `07-feedback-loop` / `templates/verification-result-template` / `templates/review-report-template` |
| 长闭环 - 沉淀 | `08-delivery-memory` / `delivery-memory/` |
| 长闭环 - 复盘 | `11-delivery-memory-practice` |
| 长闭环 - 治理 | `12-continuous-governance` |
| 短 ↔ 长 衔接 | `09-phase-two-alignment` / `10-agent-working-protocol` |

**结构性问题**：现有规程把"沉淀（08）"、"复盘（11）"、"治理（12）"做成了三个先后阶段，但它们应是**长闭环的三个环节**而非顺序步骤。改造时应让其循环引用，不再做线性串联。

## 七、闭环成立的最小验证集

要证明闭环真的形成，建议三个最小验证项：

1. **能找到一次"返工 → 沉淀 → 回写"的完整轨迹** — 某次失败的返工被沉淀进 Memory，且后来某次 Governance 检测把它回写成了 01-08 中的一条新规则。
2. **每次任务启动时有读取 Memory 的动作** — 不是"写完就放着"。
3. **Governance 报告里有"本次回写了哪些规程"的字段** — 没有此字段，长闭环就是开环。

## 八、落地次序

按系统工程"先短后长、先观测后控制"的原则：

| 顺序 | 动作 | 涉及边 | 目标 |
| --- | --- | --- | --- |
| 第一步 | 走通 Feedback → Context / Architecture 的返工通路 | ③ ④ | 单次任务能自我纠错 |
| 第二步 | 走通 Feedback → Entropy 的沉淀通路 | ⑤ | 经验有载体 |
| 第三步 | 走通 Entropy → 其他三面的回写通路 | ⑥ ⑦ ⑧ | 长闭环成立 |

理由：先做 ⑥⑦⑧ 而短闭环还没通，等于在不稳定的基础上做演化控制，会放大噪音。

## 九、与改进计划的关系

本闭环模型不取代 `.claude/harness-engineering/harness-engineering-improvement-plan.html` 中的四控制面信息架构调整，而是为其补充：

- 改进计划解决"信息架构是什么"。
- 本闭环模型解决"信息架构之间如何流动、如何自我修正"。

两者关系：改进计划阶段 A 建立四控制面的目录骨架后，本模型用于驱动阶段 B / C / D 的对齐工作。

