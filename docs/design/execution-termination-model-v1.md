# Execution Termination Model v1

## 1. Goal

Provide one structured termination contract for user cancellation, phase deadlines, Runtime watchdog timeouts, service shutdown, superseded work, and maintenance. Runtime adapters, orchestration, queues, recovery, audit APIs, and UI must not infer these causes from native exception text.

## 2. Boundary

This model changes execution lifecycle semantics. It does not add a new business workflow, approval flow, database, or Runtime implementation.

The authoritative type definitions live in `packages/shared/src/contracts.ts`. Server-side factories and policy helpers live in `apps/server/src/common/execution-termination.ts`.

## 3. Contract

```ts
type ExecutionTerminationKind =
  | 'user_cancelled'
  | 'frontend_disconnected'
  | 'phase_timeout'
  | 'runtime_timeout'
  | 'service_shutdown'
  | 'superseded'
  | 'maintenance'

type ExecutionTermination = {
  schemaVersion: '1.0'
  terminationId: UUID
  kind: ExecutionTerminationKind
  source: 'user' | 'orchestrator' | 'runtime' | 'system' | 'operator'
  scope: 'session' | 'phase' | 'invocation' | 'service'
  occurredAt: ISODateTime
  phase?: AgentRunPhase
  timeout?: {
    mode: 'deadline' | 'first_frame' | 'idle' | 'absolute'
    timeoutMs: number
  }
  graceful?: boolean
  replacementInvocationId?: UUID
  maintenanceId?: string
  diagnosticRef?: string
}
```

`AgentRunResult.termination` is authoritative. `RuntimeError.termination` is dual-written for compatibility with existing error consumers. Existing `RuntimeInvocationStatus`, `RUNTIME_CANCELLED`, and `RUNTIME_TIMEOUT` remain available during migration.

## 4. Compatibility Mapping

| Kind | Invocation status | Legacy code | Default disposition | Session behavior |
| --- | --- | --- | --- | --- |
| `user_cancelled` | `cancelled` | `RUNTIME_CANCELLED` | stop | explicit cancel becomes `CANCELLED`; pause remains `WAIT_USER_DECISION` |
| `phase_timeout` | `failed` | `RUNTIME_TIMEOUT` | retry | bounded phase policy |
| `runtime_timeout` | `failed` | `RUNTIME_TIMEOUT` | retry | bounded Runtime policy |
| `service_shutdown` | `cancelled` | `RUNTIME_CANCELLED` | interrupt | persist `INTERRUPTED` with wakeable metadata; never auto-run |
| `superseded` | `cancelled` | `RUNTIME_CANCELLED` | replace | retain status and start replacement |
| `maintenance` | `cancelled` | `RUNTIME_CANCELLED` | recover | retain status until maintenance ends |

The termination is a fact. Retry, replace, recover, and stop are policy decisions and must not be guessed by adapters.

## 5. Ownership

- Sessions creates `user_cancelled` for explicit user cancellation or pause. Pausing stops the current attempt but preserves resumable Session state.
- Orchestrator creates `phase_timeout` and `superseded`.
- Runtime adapters create or expose `runtime_timeout` for their own watchdogs.
- Application lifecycle creates `service_shutdown`.
- Maintenance Coordinator creates `maintenance`.
- RuntimeService normalizes all adapter results and persists the termination on the invocation log.
- Event/UI layers consume the structure and never reclassify native text.

Every `AbortController.abort()` in an execution path must receive an `ExecutionTermination`. Native AbortError messages are diagnostics, not user-facing content.

## 6. Arbitration

The first termination reason wins. A later cancellation or timeout must not replace the reason already stored in `AbortSignal.reason`. This makes races between a user cancellation, a phase deadline, a Runtime watchdog, and shutdown deterministic.

## 7. Phase Deadlines

`phaseTimeoutMs(phase)` resolves an optional deadline for every Agent phase. `PHASE_TIMEOUT_<PHASE>_MS` is authoritative. `DISCUSSION_TIMEOUT_MS` remains a compatibility fallback for Discussion only. Zero delegates timeout ownership to the selected Runtime watchdog.

## 8. Shutdown and Recovery

On graceful shutdown, SessionsService first persists active work as a wakeable `INTERRUPTED` Session. ExecutionService then stops accepting work, broadcasts `service_shutdown`, waits for `SHUTDOWN_EXECUTION_GRACE_MS`, and allows Worker, Queue, and persistence providers to close.

After an ungraceful process exit, RecoveryService detects a `runtime_started` event without a matching terminal Runtime event. It records `service_shutdown` with `graceful=false`, moves unfinished tasks to `waiting`, and persists the Session as wakeable `INTERRUPTED`. It must not re-drive discussion, commands, tests, or file writes. A future user-initiated wake-up creates a new invocation after revalidation.

## 9. Events and UI

Termination events keep the existing `runtime_failed` event type during the compatibility period and add `termination` to the payload.

- Phase and Runtime timeouts render as errors.
- Service shutdown and maintenance render as recoverable waiting notices.
- Superseded work renders as replacement progress.
- User cancellation renders as a neutral terminal notice.
- Raw native errors remain in bounded, sanitized Debug/Audit fields only.

## 10. Verification

Required coverage includes all seven termination kinds, first-reason arbitration, phase/Runtime timeout races, explicit RunHandle cancellation, graceful shutdown, crash recovery, maintenance, superseded execution, frontend disconnect, BullMQ parity, safe UI copy, typecheck, unit tests, key e2e flows, and production builds.
