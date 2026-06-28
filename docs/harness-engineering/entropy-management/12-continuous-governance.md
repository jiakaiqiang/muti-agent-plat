# 12 Continuous Governance 第五阶段持续治理与演进

> 最后修改时间：2026-06-12 11:20:34 +08:00
> 修改人：Claude Code
> 修改的 Agent：Claude Code

## 目的

第五阶段不是写代码，不是新增系统功能，也不是做自动化检查平台。

第五阶段的目标是：

```text
建立 Harness Engineering 的持续治理机制，
让规程、Agent 行为、上下文、工具治理、交付记忆能够长期保持有效。
```

第一阶段定义规程。

第二阶段对齐现有协作流程。

第三阶段固化 Agent 工作协议。

第四阶段建立交付记忆与复盘机制。

第五阶段解决：

```text
这些规程如何长期不失效、不漂移、不被绕过。
```

## 第五阶段要解决的问题

如果没有持续治理，Harness Engineering 会逐渐退化：

```text
Agent 开始越权
上下文越来越臃肿
需求契约变成形式化模板
工具治理被绕过
人工确认只剩口头确认
返工分类越来越模糊
交付记忆越来越脏
旧规程不再适合新项目状态
```

第五阶段要建立一套定期复查和演进规则。

## 熵管理

Harness 熵 = 使 Agent 更难稳定完成任务的无序因素。

| 熵类型 | 表现 |
| --- | --- |
| context_entropy | 上下文过载、冲突、过期、噪音 |
| architecture_entropy | 边界模糊、职责扩散、依赖方向混乱 |
| rule_entropy | 规程重复、冲突、过期、难以执行 |
| memory_entropy | 长期记忆污染、重复、过期、来源不明 |
| scope_entropy | 任务范围膨胀、非目标失效 |
| behavior_entropy | Agent 越权、跳阶段、自由发挥 |
| tool_entropy | 工具调用无记录、风险分级失真 |

降熵动作复用“治理决策类型”词表，不另立动作清单。

熵阈值：出现以下任一情况时，必须先降熵再推进，不得带病推进：

- conflict 或 stale 上下文条目正在影响当前阶段决策。
- 同一任务内第 2 次出现 entropy_signal。

## 反扩张规则

新增任何 Harness 文档前必须先回答四问：

1. 是否可以修改已有文档解决？
2. 是否会制造重复规则？
3. 属于 core、templates 还是 reference？
4. 是否有明确维护者和过期条件？

任何一问不通过，不新增文档。

## 治理对象

持续治理覆盖 8 个对象：

```text
1. Intent Contract 质量
2. Context Protocol 执行情况
3. Agent Role 边界
4. Stage Workflow 交接纪律
5. Tool Governance 执行情况
6. Human Intervention 记录质量
7. Feedback Loop 返工质量
8. Delivery Memory 质量
```

## 治理节奏

建议分三种节奏：

### 每次交付后

检查：

```text
本次是否按规程完成？
是否出现越权？
是否出现上下文不足或过载？
是否有未记录的人工确认？
是否有返工但没有分类？
是否有应沉淀但未沉淀的经验？
```

### 每周或每批次

检查：

```text
最近多次交付是否重复出现同类问题？
哪些 Agent 最容易越权？
哪些阶段最容易返工？
哪些上下文经常缺失？
哪些规程最难执行？
```

### 每月或版本节点

检查：

```text
规程是否过期？
Agent 工作协议是否需要更新？
交付记忆是否污染？
工具治理是否仍符合风险边界？
是否需要增加、合并或删除规程？
```

## 治理维度

### 1. Intent Contract 质量

检查问题：

```text
需求契约是否清楚？
验收标准是否可判断？
非目标是否明确？
风险是否被识别？
待确认问题是否被处理？
```

常见漂移：

```text
需求契约变成一句话摘要
验收标准变成主观描述
非目标缺失
风险缺失
待确认问题被跳过
```

治理动作：

```text
更新 Intent Contract 规程
补充示例
调整 Requirement Agent 工作协议
```

### 2. Context Protocol 执行情况

检查问题：

```text
Agent 是否拿到了正确上下文？
是否拿到了过多无关上下文？
是否缺少关键上游产物？
是否混入未确认信息？
```

常见漂移：

```text
上下文越来越多
Agent 看到与当前阶段无关的信息
阶段之间事实与假设混在一起
Review 看不到全过程产物
```

治理动作：

```text
收紧上下文边界
补充不同阶段上下文样例
更新 Agent 工作协议中的输入要求
```

### 3. Agent Role 边界

检查问题：

```text
Requirement Agent 是否开始设计？
Architect Agent 是否直接实现？
Implementation Agent 是否扩大范围？
Verification Agent 是否主导需求变更？
Review Agent 是否独立判断？
Delivery Agent 是否遗漏交付记忆？
```

常见漂移：

```text
Agent 为了推进流程而越权
Coordinator 替代 Review 决策
Implementation 顺手修设计
Delivery 只做总结不做记忆沉淀
```

治理动作：

```text
更新 Agent 工作协议
补充越权示例
明确越权后的返工路径
```

### 4. Stage Workflow 交接纪律

检查问题：

```text
阶段是否跳过？
阶段产物是否完整？
下游是否能基于上游产物继续？
交接是否依赖聊天记录而非结构化产物？
```

常见漂移：

```text
没有完整需求契约就进入设计
没有设计方案就开始实现
Review 输入不完整
Delivery 无法追溯全过程
```

治理动作：

```text
更新阶段准入条件
补充交接清单
强化 Review 对交接产物的检查
```

### 5. Tool Governance 执行情况

检查问题：

```text
工具使用是否留痕？
高风险动作是否确认？
越界动作是否停止？
外部调用是否被明确批准？
```

常见漂移：

```text
中风险动作无记录
高风险动作被包装成普通动作
真实外部调用没有确认
工具权限不足时 Agent 自行绕过
```

治理动作：

```text
更新风险分级
补充工具使用示例
明确哪些动作必须进入 Human Intervention
```

### 6. Human Intervention 记录质量

检查问题：

```text
人工确认是否记录原因？
是否记录选择？
是否记录确认后回到哪个阶段？
是否把口头确认误当成长期偏好？
```

常见漂移：

```text
只写“用户已确认”
没有确认选项和理由
确认内容和后续阶段脱节
临时选择被沉淀为长期偏好
```

治理动作：

```text
更新人工干预记录格式
明确哪些确认可进入 Delivery Memory
```

### 7. Feedback Loop 返工质量

检查问题：

```text
返工是否分类？
目标阶段是否正确？
是否存在原地修复跨阶段问题？
是否重复返工不收敛？
```

常见漂移：

```text
所有失败都回 Implementation
需求问题被当成实现问题
设计问题靠实现绕过
连续返工没有升级人工确认
```

治理动作：

```text
更新返工路由表
补充失败分类样例
更新 Review Agent 工作协议
```

### 8. Delivery Memory 质量

检查问题：

```text
长期记忆是否可复用？
是否写入一次性噪音？
是否重复？
是否过期？
是否污染后续 Agent 判断？
```

常见漂移：

```text
所有交付日志都被写成记忆
一次性路径变成长期知识
旧结论没有 stale 标记
用户临时选择变成默认偏好
```

治理动作：

```text
标记 stale / superseded
合并重复记忆
删除或降级噪音
更新 Delivery Memory 写入规则
```

## 治理产物

治理结论默认记录在本文档的变更记录和交付回复中，不预设独立文件。

只有当某类治理检查反复执行、本文档承载不下时，才按"反扩张规则"四问新增清单文件，且新增时必须声明维护者和过期条件。

## 规程变更规则

Harness Engineering 规程可以演进，但不能随意改。

每次规程变更必须说明：

```text
为什么改
影响哪些 Agent
影响哪些阶段
是否影响已有交付记忆
是否需要更新 Agent 工作协议
是否需要更新模板
```

规程新增或修改强制章节时，必须在同一批改动中更新 `tests/harness-engineering/` 对应脚本的标记检查。

规程变更记录建议包含：

```text
变更日期
变更原因
变更前规则
变更后规则
影响范围
迁移建议
```

## 治理决策类型

治理评审可以给出以下结论：

```text
keep        规程继续有效
adjust      规程需要小幅调整
split       规程过大，需要拆分
merge       规程重复，需要合并
deprecate   规程过期，需要废弃
escalate    问题严重，需要人工决策
trim        裁剪无关上下文或冗余规则
stale       标记过期记忆或结论
quarantine  隔离未确认信息
rollback    回退到正确阶段
summarize   将复杂过程压缩成结构化产物
```

## 第五阶段不做什么

第五阶段不做：

```text
不写自动治理程序
不新增系统功能
不新增测试平台
不把治理变成打分表演
不追求一次性完美规程
```

第五阶段只做：

```text
规程复查
行为漂移识别
上下文漂移识别
工具治理复查
交付记忆质量复查
规程变更记录
持续演进
```

## 完成标准

第五阶段完成的标志是：

```text
有固定治理节奏。
有明确治理对象。
有行为漂移检查方式。
有交付记忆质量复查方式。
有规程变更记录方式。
规程能根据真实交付经验持续演进。
```

完成第五阶段后，Harness Engineering 不再只是一次性文档，而是一套可长期维护的 Agent 工程协作体系。

## 回写动作清单

本节定义当治理评审给出 `adjust` / `split` / `merge` / `deprecate` 决策后，治理结论如何回写到其他三个控制面。对应闭环模型中的边 ⑥（→ Context）、边 ⑦（→ Architecture）、边 ⑧（→ Feedback）。

### 边 ⑥ 回写 Context（上下文工程）

| 触发漂移 | 回写对象 | 回写动作 |
| --- | --- | --- |
| Intent Contract 模板形式化 | `../context-engineering/01-intent-contract.md` | 调整验收标准要求、补充非目标字段示例 |
| 阶段上下文缺失或越界 | `../context-engineering/02-context-protocol.md` | 调整对应阶段的"应该看到 / 不应该看到"列表 |
| Prompt 漂移、Agent 系统提示退化 | `../context-engineering/prompt-context/` | 更新 prompt 契约、补充上下文组装样例 |
| 返工信号重组上下文未生效 | `../context-engineering/02-context-protocol.md` 返工信号入口 | 增补缺失字段或重组规则 |

### 边 ⑦ 回写 Architecture（架构约束）

| 触发漂移 | 回写对象 | 回写动作 |
| --- | --- | --- |
| Agent 越权、边界模糊 | `../architecture-constraints/03-agent-role-protocol.md` | 调整角色边界、补充越权示例 |
| 阶段交接缺产物或跳阶段 | `../architecture-constraints/04-stage-workflow.md` | 调整准入 / 退出条件、补充交接清单 |
| 工具风险等级不匹配实际后果 | `../architecture-constraints/05-tool-governance.md` + `../architecture-constraints/capability-binding/` | 同步调整风险分级与工具绑定，两处必须同时改 |
| Agent 工作协议过时 | `../architecture-constraints/10-agent-working-protocol.md` | 更新 Agent 必须输入 / 输出 / 返工触发 |

### 边 ⑧ 回写 Feedback（反馈循环）

| 触发漂移 | 回写对象 | 回写动作 |
| --- | --- | --- |
| 出现现有路由表无法分类的失败 | `../feedback-loop/07-feedback-loop.md` 返工路由 | 新增问题类型与对应回退阶段 |
| 连续返工不收敛阈值不合适 | `../feedback-loop/07-feedback-loop.md` 硬规则 | 调整次数阈值，同步更新 `../feedback-loop/06-human-intervention.md` 触发条件 |
| 人工介入触发条件遗漏 | `../feedback-loop/06-human-intervention.md` | 新增触发场景与确认字段 |
| 字段映射与对接出现脱节 | `../feedback-loop/07-feedback-loop.md` 字段映射表 | 与 `02` 和 `08` 同步对齐字段名 |

### 回写硬规则

- 回写动作必须基于至少 2 次交付的同类漂移证据，单次现象不触发回写。
- 每次回写必须在 `docs/harness-engineering/governance/rule-change-log.md` 中记录：触发漂移、证据来源（交付编号或记忆条目）、影响范围、回写位置、迁移建议。
- 跨控制面影响的回写必须一次性完成。例如工具风险等级调整必须同时改 `05` 和 `../architecture-constraints/capability-binding/`，不允许只改其一。
- 回写后必须在下一次治理节奏中验证是否生效，未生效则升级为 `escalate`。

### 闭环可观测性

为证明长闭环成立，治理报告必须包含：

- 本次治理回写了哪些规程（按边 ⑥⑦⑧ 分类列出）。
- 回写动作的证据来源（哪些 Delivery Memory 条目支撑）。
- 上次治理的回写动作在本次复查中是否仍有效。

回写动作数长期为零时，长闭环判定为开环，需进入 `escalate`。
