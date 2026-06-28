# Governance 治理记录

本目录承接 Harness Engineering 的长闭环治理产物，属于 `docs/harness-engineering/` 草案与治理区，不直接作为 Agent 执行规程。

## 文件

| 文件 | 用途 |
| --- | --- |
| `rule-change-log.md` | 记录 Entropy Management 回写动作 |
| `known-failures.md` | 记录可复用失败模式和预防方式 |

## 使用规则

- 修改 `.claude/harness-engineering/` 核心规程前，应先在本目录或审计文档中留下证据。
- 每次回写至少记录：触发原因、证据来源、影响范围、修改位置、后续验证方式。
- 单次偶发现象只登记候选，不直接回写长期规则。
