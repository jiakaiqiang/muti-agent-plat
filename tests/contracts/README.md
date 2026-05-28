# Contract Test Notes for v0.1

This folder defines the test skeleton for the five v0.1 contracts in
`docs/contracts`:

- `api-contract-v0.1.md`
- `data-contract-v0.1.md`
- `event-contract-v0.1.md`
- `runtime-contract-v0.1.md`
- `ui-state-contract-v0.1.md`

The current repository does not yet expose a shared test runner at the root, so
these files are runner-neutral acceptance skeletons. When the server and web
implementations stabilize, wire them into the local runner without changing the
expected behavior described here.

## Scope

Contract tests must verify the observable behavior of the collaboration loop:

1. Create session.
2. Agents discuss and create a task brief.
3. User confirms the brief.
4. Tasks are created and dry-run execution starts.
5. Runtime and RAG events are persisted and rendered.
6. Post review validates the work.
7. Final delivery is created.

The tests also cover two non-happy-path collaboration requirements:

- A user sends an interrupting message while the session is `EXECUTING`.
- An agent receives RAG matches, and those matches are visible in the event
  stream and at least one UI-derived state.

## Non-Goals

- No direct edits to application source.
- No assumptions about a specific database, browser runner, or mock server.
- No destructive setup or teardown. Test data should be isolated by generated
  IDs and deleted only through supported public APIs once those APIs exist.

## Required Fixtures

- `tests/fixtures/collaboration-main-chain.v0.1.json` describes the canonical
  event sequence used by API, event, runtime, and UI state tests.

## Acceptance Rule

A v1 build is acceptable only when the matrix in
`docs/quality/v1-acceptance-matrix.md` has no `P0` or `P1` item left in
`Not Covered` or `Blocked` state.
