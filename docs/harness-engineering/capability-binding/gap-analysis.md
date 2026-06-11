# Phase 4 Gap Analysis

> 最后修改时间：2026-06-11 14:47:47 +08:00
> 修改人：Codex
> 修改的 Agent：Codex

- 完整: capability governance is fully auditable.
- 部分: capability exists but engineering semantics are incomplete.
- 缺失: audit binding is missing.

| ID | Status | Gap |
| --- | --- | --- |
| Q1 | 部分 | checkInvocation should record affected stage. |
| Q2 | 部分 | approvalKey should be linked to execution evidence. |
| Q3 | 缺失 | capability_invocations needs reusable audit semantics. |
| Q4 | 部分 | risk examples should be maintained across projects. |
| Q5 | 缺失 | file write, command run, and external send need one confirmation template. |

## Definition of Done

Capability Binding is complete when every risky action can answer who requested it, why, risk level, confirmation result, and evidence.
