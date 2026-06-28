# Known Failures

> 记录 Harness Engineering 可复用失败模式。单次猜测不写入；只有可复现、可预防的问题才登记。

## KF-001 工具能力被按工具名一刀切定级

- 状态：mitigated
- 现象：`05-tool-governance.md` 允许范围内写入和本地验证命令作为中风险，但 capability binding 把 `tool.file_write` / `tool.command_run` 整体标为高风险。
- 影响：Agent 执行时无法判断何时可留痕执行、何时必须人工确认。
- 预防：统一使用“能力基础风险 + 单次调用上下文”的模型；越界、破坏性、外部副作用、生产数据、真实费用均升级为高风险。
- 回写记录：`rule-change-log.md` GOV-2026-06-28-001。

## KF-002 模板残留历史 Agent 别名

- 状态：mitigated
- 现象：模板中残留 `requirements`、`backend`、`frontend`、`test`、`notification` 等历史命名。
- 影响：与 03 Agent Role Protocol 的 7 个标准 Agent 冲突。
- 预防：模板 metadata 使用 `*-agent` key，说明文字使用标准 Agent 名。
- 回写记录：`rule-change-log.md` GOV-2026-06-28-001。

## KF-003 长闭环回写无日志载体

- 状态：partially mitigated
- 现象：`12-continuous-governance.md` 要求 `rule-change-log.md`，但文件不存在。
- 影响：无法证明 Entropy Management 已经把治理结论回写到其他控制面。
- 预防：所有后续回写都必须记录到 `rule-change-log.md`。
- 剩余风险：仍需通过后续真实交付证明“返工 -> 沉淀 -> 回写”闭环。
