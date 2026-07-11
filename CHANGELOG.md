# Changelog

## Unreleased

### Added

- Added a unified `AgentRuntimeRunHandle` lifecycle for streaming Runtime execution.
- Added Codex app-server JSONL and Claude stream-json adapters with cancellation, watchdogs, structured output, usage and artifacts.
- Added CLI session persistence, validated resume and one-shot `RESUME_FALLBACK`.
- Added ActorRef v0.2 task/event dual-write plus file and PostgreSQL collection backfill support.
- Added recoverable Workdir Brief injection with sidecars, byte-exact restore, leases, startup recovery and TTL cleanup.
- Added Skill CRUD, Agent binding and deterministic ContextPack/Workdir Brief injection.
- Added a Skill management workspace for CRUD, files, Agent binding, deletion impact and redacted injection previews.
- Added feature-gated Autopilot CRUD, manual trigger, BullMQ scheduling, active-run issueguard and session tracing.
- Added streaming Runtime metrics, detailed Watchdog timeout diagnostics, cost-gated 20-run sampling and percentile baseline reports.

### Changed

- Orchestrator consumes streaming events from the current run handle instead of querying an adapter handle map after startup.
- Codex/Claude legacy `execFile` execution remains the default while `ENGINEERING_RUNTIME_STREAMING` is `off`.
- Frontend actor and task assignment rendering now prefers ActorRef and falls back to deprecated agent ID fields.
- Codex/Claude first-frame and idle thresholds are independently configurable; absolute timeout remains disabled unless explicitly set.

### Validation

- Typecheck, server tests (338/338), Web tests (2/2), Harness conformance and workspace build pass.
- Controlled e2e coverage includes Codex/Claude streaming, session resumption, Workdir Brief, Skill injection/management, Autopilot and legacy runtime paths.
