# Artifacts Alignment 产物对齐

> 最后修改时间：2026-06-11 14:47:47 +08:00
> 修改人：Codex
> 修改的 Agent：Codex

## 目的

`Artifacts` 只存储物料本身。Harness Engineering 还需要一层额外语义 `harnessArtifactType`，让同一份物料在不同项目里也能被一致解释。

## ArtifactType 存储矩阵

| ArtifactType | 用途 |
| --- | --- |
| text | 短笔记或决策摘要。 |
| markdown | 人类可读的契约、计划、评审、交付。 |
| json | 机器可读的契约或证据。 |
| code_diff | 实现证据。 |
| test_report | 验证证据。 |
| feishu_draft | 外发通知草稿。 |
| url | 外部引用。 |
| file | 工作区文件产物。 |

## harnessArtifactType 工程语义

- intent_contract
- design_plan
- task_plan
- implementation_summary
- verification_summary
- review_report
- final_delivery

## 规则

`ArtifactType` 回答"物料怎么存储"。`harnessArtifactType` 回答"在工程流程中扮演什么角色"。
