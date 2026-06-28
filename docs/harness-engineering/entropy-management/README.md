# Entropy Management 熵管理控制面

## 系统工程角色

演化控制。决定系统本身怎么自我修正。

**唯一具备"回写"能力的控制面**。其他三个控制面被驱动，本控制面驱动其他三个的长期演化。

是闭环模型中：

- 边 ⑤ 的接收方（接收 Feedback 的沉淀候选）
- 边 ⑥ ⑦ ⑧ 的出口（向 Context / Architecture / Feedback 回写）
- 长闭环的核心枢纽

## 负责

- 长期记忆的 5 类分类（项目知识 / 设计决策 / 失败模式 / 验收经验 / 用户偏好）
- 沉淀触发时机与字段对接（边 ⑤ 入口）
- 候选 → 正式沉淀的筛选规则
- 漂移检测节奏（每次交付 / 每周 / 每月）
- 回写动作清单（边 ⑥ ⑦ ⑧ 出口）
- 治理决策类型：keep / adjust / split / merge / deprecate / escalate
- 闭环可观测性指标（回写动作数）

## 不负责

- 不负责单次任务的执行（属于 Architecture）
- 不负责单次返工修复（属于 Feedback）
- 不负责未经筛选直接写入长期记忆（候选 ≠ 沉淀）
- 不负责绕过 Governance 直接修改 01-08 规程（长期规则修改必须经回写）

## 旧文件映射

| 关注点 | 权威位置 |
| --- | --- |
| 沉淀原则与 5 类记忆 | `./08-delivery-memory.md` |
| 沉淀触发与字段对接（边 ⑤ 接收） | `./08-delivery-memory.md` 末节 |
| 复盘流程 | `./11-delivery-memory-practice.md` |
| 漂移检测 + 回写动作清单（边 ⑥ ⑦ ⑧ 出口） | `./12-continuous-governance.md` |
| 回写动作日志（长闭环证据） | `../../../docs/harness-engineering/governance/rule-change-log.md` |
| 已知失败模式 | `../../../docs/harness-engineering/governance/known-failures.md` |
| 记忆载体 | `./delivery-memory/` |

## 闭环检查项

- 回写动作数是否长期为零（为零则长闭环判定为开环）
- 每次回写是否在 `rule-change-log.md` 中留痕
- 回写动作是否基于至少 2 次同类漂移证据（单次现象不触发回写）
- 跨控制面影响是否一次性完成（如 05 与 capability-binding 同步）
- 上次回写动作在本次治理中是否仍生效

## 与其他控制面的边

- 边 ⑤ 入口：Feedback → Entropy（沉淀候选）
- 边 ⑥ 出口：Entropy → Context（模板 / prompt 修正）
- 边 ⑦ 出口：Entropy → Architecture（边界 / 工具演化）
- 边 ⑧ 出口：Entropy → Feedback（新分类 / 新触发）

## 长闭环三环节关系

08 / 11 / 12 不是先后阶段，而是循环引用：

```text
08 原则 → 11 复盘流程 → delivery-memory/ 载体 → 12 漂移检测与回写
                                                    ↓
                                            08 原则更新（回写）
```
