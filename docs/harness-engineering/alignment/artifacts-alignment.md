# Artifacts Alignment

## Purpose

Artifacts store materials. Harness Engineering needs an additional semantic layer named harnessArtifactType so the same material can be understood across projects.

## ArtifactType storage matrix

| ArtifactType | Usage |
| --- | --- |
| text | Short notes or decision summaries. |
| markdown | Human-readable contracts, plans, reviews, and delivery. |
| json | Machine-readable contracts or evidence. |
| code_diff | Implementation evidence. |
| test_report | Verification evidence. |
| feishu_draft | External notification draft. |
| url | External reference. |
| file | Workspace file artifact. |

## harnessArtifactType semantics

- intent_contract
- design_plan
- task_plan
- implementation_summary
- verification_summary
- review_report
- final_delivery

## Rule

ArtifactType answers how the artifact is stored. harnessArtifactType answers what role it plays in the engineering workflow.
