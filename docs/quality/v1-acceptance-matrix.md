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
| Q-P1-001 | User interrupt | User message during `EXECUTING` is persisted before routing, returns a handling plan, and pauses the session when `shouldPause = true`. | API, Event, Runtime, UI State | `tests/e2e/p1-behaviors.spec.ts`, `output/playwright/v1-final-wait-user-decision.png` | Covered |
| Q-P1-002 | Interrupt priority | Interrupting constraint/correction affecting task contract has priority at least `high`. | Event, Runtime | `tests/e2e/p1-behaviors.spec.ts` | Covered |
| Q-P1-003 | RAG hit | Knowledge search returns `RagMatchedChunk[]` and emits `rag_retrieved` with source content from the bound knowledge base. | API, Data, Event, Runtime | `tests/e2e/collaboration-main-chain.spec.ts`, `tests/e2e/p1-behaviors.spec.ts` | Covered |
| Q-P1-004 | RAG visibility | RAG source appears in chat or Agent card derived state. | UI State, Event | `apps/web/src/stores/event.ts`, `.codex-run/agent-web-real-api-confirmed-fixed.png` | Covered |
| Q-P1-005 | SSE reconnect | Reconnect backfill uses `afterEventId`, does not duplicate events, and a reconnected stream can receive later live events. | API, Event, UI State | `tests/e2e/collaboration-main-chain.spec.ts`, `tests/e2e/p1-behaviors.spec.ts` | Covered |
| Q-P1-006 | API errors | Missing resources and invalid session transitions return contract error codes and `requestId`. | API | `tests/e2e/collaboration-main-chain.spec.ts`, `tests/e2e/p1-behaviors.spec.ts` | Covered |
| Q-P1-007 | Session transitions | External pause, resume, cancel, and brief-revision controls reject unsupported status transitions; resolving a `WAIT_USER_DECISION` confirmation persists the decision result. | API, UI State | `tests/e2e/p1-behaviors.spec.ts`, `output/playwright/v1-final-wait-user-decision.png` | Covered |
| Q-P1-008 | Memory and debug | Session Memory can be created, searched, injected into Context Pack, and inspected through Debug API. | API, Runtime, Data | `tests/e2e/debug-memory-smoke.mjs` | Covered |

## P2 Quality Gates

| ID | Area | Acceptance Item | Contract Source | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| Q-P2-001 | Data naming | API uses `camelCase`; database-facing model uses `snake_case`. | Data | `tests/e2e/collaboration-main-chain.spec.ts` | Covered |
| Q-P2-002 | Default agents | Seed data provides the eight required default agent keys. | Data | `tests/e2e/collaboration-main-chain.spec.ts` | Covered |
| Q-P2-003 | UI derivation | Agent cards, task states, confirmations, and chat messages are derived from events. | UI State, Event | `apps/web/src/stores/event.ts`, `output/playwright/v1-final-chat-completed.png`, `output/playwright/v1-final-wait-user-decision.png` | Covered |
| Q-P2-004 | Artifact retrieval | Session artifacts and artifact detail APIs return review and delivery artifacts. | API, Data | `tests/e2e/collaboration-main-chain.spec.ts` | Covered |
| Q-P2-005 | Runtime failures | Failed runtime returns `error`; completed runtime returns `output` and `usage`. | Runtime | `tests/e2e/collaboration-main-chain.spec.ts` | Covered |
| Q-P2-006 | HTTP security boundary | API allows only configured CORS origins and emits baseline security headers. | DevOps, API | `tests/e2e/security-smoke.mjs` | Covered |

## Exit Criteria

v1 can be accepted when:

- All P0 items are `Covered`.
- All P1 items are `Covered` or have an approved owner and mitigation.
- No P0/P1 item remains `Blocked`.
- The canonical fixture still represents the supported v1 happy path.
- Manual exploratory testing confirms the same event sequence is visible in the
  three required views: chat, collaboration graph, and workflow. Evidence:
  `output/playwright/v1-final-chat-completed.png`,
  `output/playwright/v1-final-collaboration-graph.png`,
  `output/playwright/v1-final-workflow.png`.
- Browser exploratory testing confirms the debug view and executing-interrupt
  decision card render without console errors or warnings. Evidence:
  `output/playwright/v1-final-debug.png`,
  `output/playwright/v1-final-wait-user-decision.png`.
