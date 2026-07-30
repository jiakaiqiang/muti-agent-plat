# v1 Acceptance Matrix

> 更新时间：2026-07-29
> 本矩阵覆盖 v1 闭环验收和当前工作树新增的 v1+ 可靠性/治理能力。状态为 `Covered` 表示已有自动化或人工质量门，并非表示功能已达到生产级真实执行。

Status values:

- `Planned`: test skeleton exists; implementation wiring is pending.
- `Covered`: automated or manual quality gate exists and passes in the documented baseline.
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
| Q-P1-001 | User interrupt | User message during execution is persisted before routing, returns a handling plan, and creates an auditable interruption/update path. | API, Event, Runtime, UI State | `tests/e2e/p1-behaviors.spec.ts`, `tests/e2e/requirement-revision-loop-smoke.mjs` | Covered |
| Q-P1-002 | Interrupt priority | Interrupting constraint/correction affecting task contract has priority at least `high`. | Event, Runtime | `tests/e2e/p1-behaviors.spec.ts` | Covered |
| Q-P1-003 | RAG hit | Knowledge search returns `RagMatchedChunk[]` and emits `rag_retrieved` with source content from the bound knowledge base. | API, Data, Event, Runtime | `tests/e2e/collaboration-main-chain.spec.ts`, `tests/e2e/p1-behaviors.spec.ts` | Covered |
| Q-P1-004 | RAG visibility | RAG source appears in chat or Agent card derived state. | UI State, Event | `apps/web/src/stores/event.ts`, `.codex-run/agent-web-real-api-confirmed-fixed.png` | Covered |
| Q-P1-005 | SSE reconnect | Reconnect backfill uses `afterEventId`, does not duplicate events, and a reconnected stream can receive later live events. | API, Event, UI State | `tests/e2e/collaboration-main-chain.spec.ts`, `tests/e2e/p1-behaviors.spec.ts` | Covered |
| Q-P1-006 | API errors | Missing resources and invalid session transitions return contract error codes and `requestId`. | API | `tests/e2e/collaboration-main-chain.spec.ts`, `tests/e2e/p1-behaviors.spec.ts` | Covered |
| Q-P1-007 | Session transitions | External pause, resume, cancel, and brief-revision controls reject unsupported status transitions and persist confirmation decisions. | API, UI State | `tests/e2e/p1-behaviors.spec.ts`, `tests/e2e/cancel-smoke.mjs` | Covered |
| Q-P1-008 | Memory and debug | Session Memory can be created, searched, injected into Context Pack, and inspected through Debug API. | API, Runtime, Data | `tests/e2e/debug-memory-smoke.mjs` | Covered |

## P2 Quality Gates

| ID | Area | Acceptance Item | Contract Source | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| Q-P2-001 | Data naming | API uses `camelCase`; database-facing model uses `snake_case`. | Data | `tests/e2e/collaboration-main-chain.spec.ts` | Covered |
| Q-P2-002 | Default agents | Seed data provides the required default agent keys and real-data mode does not auto-persist seed agents unless configured. | Data | `tests/e2e/collaboration-main-chain.spec.ts`, `tests/e2e/real-agents-no-seed-smoke.mjs` | Covered |
| Q-P2-003 | UI derivation | Agent cards, task states, confirmations, and chat messages are derived from events. | UI State, Event | `apps/web/src/stores/event.ts`, `output/playwright/v1-final-chat-completed.png`, `output/playwright/v1-final-wait-user-decision.png` | Covered |
| Q-P2-004 | Artifact retrieval | Session artifacts and artifact detail APIs return review and delivery artifacts. | API, Data | `tests/e2e/collaboration-main-chain.spec.ts` | Covered |
| Q-P2-005 | Runtime failures | Failed runtime returns `error`; completed runtime returns `output` and `usage`. | Runtime | `tests/e2e/collaboration-main-chain.spec.ts`, `tests/e2e/runtime-routing-smoke.mjs` | Covered |
| Q-P2-006 | HTTP security boundary | API allows only configured CORS origins and emits baseline security headers. | DevOps, API | `tests/e2e/security-smoke.mjs` | Covered |
| Q-P2-007 | Chinese visible copy | User-visible backend event copy is consistently Chinese and free of replacement-character mojibake. | Event, UI State | `tests/e2e/chinese-visible-copy-smoke.mjs`, `apps/server/src/common/messages.ts` | Covered |

## V1+ Hardening Gates

| ID | Area | Acceptance Item | Contract Source | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| Q-H-001 | Background execution | Session creation and brief confirmation return accepted responses while long-running work continues through events. | API, Event | `tests/e2e/collaboration-main-chain.spec.ts` | Covered |
| Q-H-002 | Runtime routing | Unsupported or reserved runtime types fail visibly instead of falling back to mock. | Runtime | `tests/e2e/runtime-routing-smoke.mjs`, `apps/server/src/modules/runtimes/runtime.service.ts` | Covered |
| Q-H-003 | Cancellation | Pause/cancel can abort in-flight execution and emit auditable runtime/task state. | Runtime, Event, UI State | `tests/e2e/cancel-smoke.mjs`, `apps/server/src/modules/execution/execution.service.ts` | Covered |
| Q-H-004 | Recovery | In-process execution mode can recover interrupted executing sessions on boot without duplicate final delivery. | API, Data, Event | `tests/e2e/recovery-smoke.mjs`, `apps/server/src/modules/recovery/recovery.service.ts` | Covered |
| Q-H-005 | BullMQ execution | Queue mode enqueues and consumes `agent-task-queue` jobs and exposes queue counts through ops API. | DevOps, Runtime | `tests/e2e/bullmq-ops-smoke.mjs`, `apps/server/src/modules/queue/` | Covered |
| Q-H-006 | Rework loop | Post-review `rework` recommendations trigger bounded automatic rework or user decision at the configured limit. | Runtime, Event | `tests/e2e/rework-loop-smoke.mjs` | Covered |
| Q-H-007 | Task dependency | Suggested task dependencies are resolved and ready tasks execute only after dependencies complete. | Data, Runtime | `tests/e2e/task-dependency-smoke.mjs`, `apps/server/src/modules/tasks/tasks.service.ts` | Covered |
| Q-H-008 | Multi-agent discussion | Discussion participants and rounds are configurable and produce runtime-backed discussion messages. | Runtime, Event | `tests/e2e/multi-agent-discussion-smoke.mjs` | Covered |
| Q-H-009 | Memory confirmation | Preference messages request confirmation before saving long-term memory candidates. | API, Event, Data | `tests/e2e/memory-confirm-smoke.mjs` | Covered |
| Q-H-010 | Token budget | Runtime context is estimated, trimmed, rejected when over budget, and usage is reflected in debug/session data. | Runtime, Debug | `tests/e2e/token-budget-smoke.mjs`, `apps/server/src/common/token.ts` | Covered |
| Q-H-011 | Workspace index first | Client snapshot upload is rejected; Session creation stores only a lightweight Provider binding, metadata indexing runs in the background, and file bodies are read on demand. | API, Runtime, UI State | `tests/e2e/workspace-snapshot-payload-smoke.mjs`, `tests/e2e/workspace-index-first-smoke.mjs`, `apps/server/src/modules/context-v2/build-envelope-from-context-assembly.spec.ts` | Covered |
| Q-H-012 | Server-local project analysis | Server-local workspace analysis can create `agent-output/` file changes without external side effects outside the workspace. | Runtime, Artifact | `tests/e2e/server-local-project-analysis-smoke.mjs` | Covered |
| Q-H-013 | File revision iteration | Three rounds preserve `W0/U1/G1/U2/G2/U3/G3`; only the final confirmed candidate writes Workspace. | API, Data, Runtime | `apps/server/src/modules/file-revisions/file-revisions.service.spec.ts` | Covered |
| Q-H-014 | File revision Receiver | Single and multi Agent runs both use one Receiver; partial failure waits for explicit retry/continue/abandon, and continue synthesizes only from successful results while retaining the failed list. | Runtime, Event | `apps/server/src/modules/orchestrator/orchestrator.service.spec.ts`, `apps/server/src/modules/sessions/sessions.service.spec.ts`, `apps/web/src/components/FileRevisionCandidateEditor.spec.ts` | Covered |
| Q-H-015 | File revision consistency | Duplicate and cross-instance reprocess requests return the same winning child; confirm requests are idempotent; opposite decisions permit one winner; stale Workspace and persistence failures never overwrite or publish uncommitted state. | API, Data | `apps/server/src/modules/file-revisions/file-revisions.service.spec.ts`, `apps/server/src/modules/sessions/sessions.service.spec.ts` | Covered |
| Q-H-016 | File revision recovery | Candidate and draft survive restart; in-flight states become visibly interrupted; explicit idempotent retry dispatches only Agent, Receiver, or apply reconciliation; applying reconciles expected/candidate/external hashes without remaining stuck. | API, Data, Recovery | `apps/server/src/modules/file-revisions/file-revisions.service.spec.ts`, `apps/server/src/modules/sessions/sessions.service.spec.ts`, `apps/server/src/modules/recovery/recovery.service.spec.ts` | Covered |
| Q-H-017 | File revision UI | Unified artifact editor renders candidate only, requires explicit submit, hides duplicate confirmation, isolates late state/candidate/draft/decision responses and per-Session busy/error state, exposes interrupted retry, and restores keyboard focus across edit and async state changes. | UI State | `apps/web/src/components/FileRevisionCandidateEditor.spec.ts`, `apps/web/src/components/ConfirmationCard.spec.ts`, `apps/web/src/stores/session-file-revision.spec.ts` | Covered |
| Q-H-018 | File revision HTTP E2E | Two revision rounds retrieve complete candidates, keep Workspace unchanged before confirmation, write only the final candidate, and reject a stale Workspace overwrite. | API, Runtime, Workspace | `tests/e2e/file-revision-candidate-iteration-smoke.mjs`, `npm run test:e2e:file-revision-candidate-iteration` | Covered |
| Q-H-019 | File revision context restart | Complete `L3.fileRevisions` remains grounded after restart without a cached Workspace Index: the safe revision path is restored into L1 navigation, while unknown, generated, and sensitive paths remain blocked. | Runtime, Context | `apps/server/src/modules/context-v2/build-envelope-from-context-assembly.spec.ts`, `apps/server/src/modules/context-v2/grounded-evidence-gate.spec.ts` | Covered |
| Q-H-020 | File revision observability and retention | Ten bounded metrics include persistence conflict separately from failure; structured transitions contain only IDs/status/version and never content; Session deletion removes only ContentStore objects with no remaining references. | Data, DevOps | `apps/server/src/common/workspace-metrics.spec.ts`, `apps/server/src/modules/persistence/local-content-store.spec.ts`, `apps/server/src/modules/file-revisions/file-revisions.service.spec.ts` | Covered |
| Q-H-021 | File revision proposal isolation | File revision Runtime selection and execution allow only read/search tools, real Adapter output limits cap candidate preflight, and artifact, acceptance, task, and failure events omit proposal/evidence content, internal prompts, model reasons, handoffs, requested context, and raw errors. | Runtime, Event, Security | `apps/server/src/modules/runtime-routing/invocation-resolver.service.spec.ts`, `apps/server/src/modules/orchestrator/file-revision-write-policy.spec.ts`, `apps/server/src/modules/orchestrator/orchestrator.service.spec.ts`, `apps/server/src/modules/runtimes/generic-llm-runtime.service.spec.ts` | Covered |
| Q-H-022 | File revision browser E2E | Two browser rounds show only the final candidate, save without dispatch, submit explicitly, keep Workspace unchanged before confirmation, write only the latest confirmed candidate, and fit desktop/mobile viewports without console errors. | API, Runtime, UI State, Workspace | `tests/e2e/browser-file-revision-candidate-iteration-smoke.mjs`, `npm run test:e2e:browser-file-revision-candidate-iteration`, `output/playwright/file-revision-candidate-desktop.png`, `output/playwright/file-revision-candidate-mobile.png` | Covered |
| Q-H-023 | File revision PostgreSQL integration | V2 projection round-trip, idempotent migration, persistence failure, and independent-connection CAS run against a real PostgreSQL instance. | Data | `apps/server/src/modules/persistence/relational/postgres-migration-runner.integration.spec.ts` | Blocked |

`Q-H-023` 本次因未配置 `RELATIONAL_TEST_DATABASE_URL` 而跳过 `3` 项真实数据库测试；其状态只描述当前验收环境，不表示 PostgreSQL 实现缺失。连接级 CAS 的单元和夹具测试已覆盖，但不能替代真实数据库失败注入，也不能表述为两个操作系统进程验证。

## Exit Criteria

v1 can be accepted when:

- All P0 items are `Covered`.
- All P1 items are `Covered` or have an approved owner and mitigation.
- No P0/P1 item remains `Blocked`.
- The canonical fixture still represents the supported v1 happy path.
- Manual exploratory testing confirms the same event sequence is visible in chat, collaboration graph, and workflow.
- Browser exploratory testing confirms the debug view and decision/confirmation cards render without console errors or warnings.

v1+ hardening can be considered complete for demo/pre-production only when:

- `runtime-routing`, `cancel`, `recovery`, `bullmq-ops`, `rework-loop`, `task-dependency`, `multi-agent-discussion`, `memory-confirm`, `token-budget`, and workspace smoke tests pass in the target environment.
- Runtime and tool capabilities that are still `预留` remain visibly disabled or explicitly fail with auditable events.
- Production deployment keeps high-risk tools, real Feishu send, and non-mock code-agent runtime disabled until their separate confirmation/sandbox gates are added.
