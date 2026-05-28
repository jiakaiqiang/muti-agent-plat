# v1 Acceptance Matrix

Status values:

- `Planned`: test skeleton exists; implementation wiring is pending.
- `Covered`: automated or manual quality gate exists and passes.
- `Blocked`: cannot execute because dependent implementation is missing.
- `Not Covered`: no gate exists.

## P0 Release Gates

| ID | Area | Acceptance Item | Contract Source | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| Q-P0-001 | Main chain | Create session -> brief -> confirm -> dry-run -> post review -> delivery reaches `COMPLETED`. | API, Event, Runtime, UI State | `tests/e2e/collaboration-main-chain.spec.ts` | Covered |
| Q-P0-002 | Event validity | Every persisted event has required fields and `metadata.schemaVersion = "0.1"`. | Event | `tests/e2e/collaboration-main-chain.spec.ts` | Covered |
| Q-P0-003 | Brief confirmation | Confirming a brief sets `confirmedByUser`, sets `confirmedAt`, emits `brief_confirmed`, and creates tasks. | API, Data, Event | `tests/e2e/collaboration-main-chain.spec.ts` | Covered |
| Q-P0-004 | Runtime dry-run | Dry-run emits `runtime_started`, `runtime_completed`, usage, and a task completion event. | Runtime, Event | `tests/e2e/collaboration-main-chain.spec.ts` | Covered |
| Q-P0-005 | Post review | Review output includes matched, missing, test result, and recommendation fields. | Runtime, Event | `tests/e2e/collaboration-main-chain.spec.ts` | Covered |
| Q-P0-006 | Final delivery | Delivery event includes summary, completed items, incomplete items, risks, and artifact IDs. | Event, Runtime, UI State | `tests/e2e/collaboration-main-chain.spec.ts` | Covered |

## P1 Release Gates

| ID | Area | Acceptance Item | Contract Source | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| Q-P1-001 | User interrupt | User message during `EXECUTING` is persisted before routing and returns a handling plan. | API, Event, Runtime | `tests/e2e/collaboration-main-chain.spec.ts` | Covered |
| Q-P1-002 | Interrupt priority | Interrupting constraint/correction affecting task contract has priority at least `high`. | Event, Runtime | `tests/e2e/collaboration-main-chain.spec.ts` | Covered |
| Q-P1-003 | RAG hit | Knowledge search returns `RagMatchedChunk[]` and emits `rag_retrieved`. | API, Data, Event, Runtime | `tests/e2e/collaboration-main-chain.spec.ts` | Covered |
| Q-P1-004 | RAG visibility | RAG source appears in chat or Agent card derived state. | UI State, Event | `apps/web/src/stores/event.ts`, `.codex-run/agent-web-real-api-confirmed-fixed.png` | Covered |
| Q-P1-005 | SSE reconnect | Reconnect backfill uses `afterEventId` and does not duplicate events. | API, Event, UI State | `tests/e2e/collaboration-main-chain.spec.ts` | Covered |
| Q-P1-006 | API errors | Missing or invalid resources return contract error codes and `requestId`. | API | `tests/e2e/collaboration-main-chain.spec.ts` | Covered |

## P2 Quality Gates

| ID | Area | Acceptance Item | Contract Source | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| Q-P2-001 | Data naming | API uses `camelCase`; database-facing model uses `snake_case`. | Data | `tests/e2e/collaboration-main-chain.spec.ts` | Covered |
| Q-P2-002 | Default agents | Seed data provides the eight required default agent keys. | Data | `tests/e2e/collaboration-main-chain.spec.ts` | Covered |
| Q-P2-003 | UI derivation | Agent cards, task states, confirmations, and chat messages are derived from events. | UI State, Event | `apps/web/src/stores/event.ts`, `.codex-run/agent-web-real-api-confirmed-fixed.png` | Covered |
| Q-P2-004 | Artifact retrieval | Session artifacts and artifact detail APIs return review and delivery artifacts. | API, Data | `tests/e2e/collaboration-main-chain.spec.ts` | Covered |
| Q-P2-005 | Runtime failures | Failed runtime returns `error`; completed runtime returns `output` and `usage`. | Runtime | `tests/e2e/collaboration-main-chain.spec.ts` | Covered |

## Exit Criteria

v1 can be accepted when:

- All P0 items are `Covered`.
- All P1 items are `Covered` or have an approved owner and mitigation.
- No P0/P1 item remains `Blocked`.
- The canonical fixture still represents the supported v1 happy path.
- Manual exploratory testing confirms the same event sequence is visible in the
  three required views: chat, collaboration graph, and workflow.
