# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Agent Cluster is a multi-agent collaboration system: a team of role-based agents discusses a user goal, produces a confirmable task brief, executes tasks through a pluggable runtime, reviews the result, and delivers a summary. Backend is NestJS, frontend is Vue 3, and a `packages/shared` contract package is the source of truth shared by both.

## Commands

This is an npm workspaces monorepo (Node >= 20, ESM-only). Run from the repo root.

```bash
npm install                              # install all workspaces
npm run build         # build all workspaces (shared must build before server consumes it)
npm run typecheck     # tsc --noEmit across all workspaces — the primary correctness gate
npm run test          # server workspace `node --test` (no unit tests exist yet → effectively a no-op)
npm run lint          # passthrough; NO workspace defines a linter, so this does nothing
```

Per-workspace dev servers:

```bash
npm run dev -w @agent-cluster/server     # build + `node --watch` on :3000 (API under /api)
npm run start -w @agent-cluster/server   # run prebuilt server WITHOUT --watch (see gotcha below)
npm run dev -w @project/web              # Vite dev server on :5173
```

Local infra (Postgres+pgvector, Redis) for full-stack runs:

```bash
docker compose up -d
```

### Tests (E2E smoke suite is the real test surface)

There are no `*.test.ts`/`*.spec.ts` unit tests in the workspaces. Verification lives in `tests/e2e/`: each `run-*.mjs` / `*-smoke.mjs` script builds `shared`+`server`, spawns the server on a free port with a temp data file and scenario-specific env, then asserts over the REST/SSE API. CI (`.github/workflows/ci.yml`) runs typecheck → build → a subset of these. Run one:

```bash
npm run test:e2e:main-chain          # full happy path: create → brief → confirm → execute → review → deliver
npm run test:e2e:interactive-messaging   # user-message routing / interrupts
npm run test:e2e:v2-runtime          # codex/claude_code CLI adapters via a fake CLI
npm run test:e2e:postgres-persistence    # requires docker compose Postgres
# ...see package.json "scripts" for the full list (security, ops, bullmq, real-data-mode, etc.)
```

## Architecture

### Contract-first monorepo
`packages/shared/src/contracts.ts` defines every domain type, enum, event type, and runtime I/O shape. Both apps import it via the `@agent-cluster/shared` alias, which resolves to **source** (`packages/shared/src/index.ts`) in `tsconfig.base.json` and `apps/web/vite.config.ts` — not built dist. Changing a contract is a cross-cutting change; the contract docs in `docs/contracts/*-v0.1.md` describe the intended stability rules (patch/minor/breaking) for v0.1.

### Backend (`apps/server`, NestJS)
Real code lives under `apps/server/src/modules/<feature>/` (one NestJS module each, wired in `app.module.ts`). The sibling top-level dirs like `src/agents/`, `src/runtimes/` are empty scaffolding — ignore them. `main.ts` sets the global `/api` prefix, CORS, and security headers.

The collaboration engine is **event-sourced**. Every meaningful step is written as a `CollaborationEvent` via `EventsService`, which both persists it and pushes it to a per-session RxJS `Subject`. `EventsController` exposes the history (`GET /sessions/:id/events`) and a live SSE feed (`GET /sessions/:id/events/stream`). The frontend derives all UI state from these events — services never push view models directly.

Session lifecycle is a state machine in `sessions.service.ts` (`SessionStatus`, with allowed transitions enforced in `assertControlTransition`). The flow, all driven by `OrchestratorService`:
1. `POST /sessions` → `AGENT_DISCUSSING`; brief planning runs **in the background** (`discussAndCreateBrief`, coordinator agent) so the HTTP call returns immediately and progress streams over SSE → `WAIT_USER_CONFIRM`.
2. `POST /sessions/:id/briefs/:briefId/confirm` → `EXECUTING`; `confirmBrief` creates tasks from the brief's suggestions and `executeRuntimeTasks` runs each task → post-review (review agent) → final delivery (coordinator) + a `feishu_draft` artifact (notification agent, draft only, never sent) → `COMPLETED`.
3. `POST /sessions/:id/messages` → the Coordinator **triages** the message first (`OrchestratorService.triageUserMessage`, an LLM call that returns a `user_message_handling_plan` with a `route`), so the Coordinator is the single decision-maker and single point of contact — it is not a regex that fans the message out. `UserMessageRouterService` is now only a **fallback** (used if the triage runtime call fails) plus a quick command check (`isQuickCommand`). The `route` drives the action: `answer` (Coordinator replies), `ask_user` (Coordinator asks one clarifying question — only when genuinely blocked), `apply_to_agents` (sync the constraint to the relevant agents internally, then the Coordinator emits **one** consolidated acknowledgement — agents never message the user directly), `revise_brief` (regenerate an unconfirmed brief → back to `WAIT_USER_CONFIRM`), `new_task`, or `command`. A constraint/correction mid-execution can still pause to `WAIT_USER_DECISION`. Per-agent behavior is shaped by personas in `orchestrator/agent-personas.ts` (injected into each runtime `systemPrompt`); only the Coordinator talks to the user.
4. `pause` / `resume` / `cancel` endpoints perform guarded status transitions.

Default agents (coordinator, requirements, architect, frontend, backend, test, review, notification) are defined in `packages/shared/src/default-agents.ts`. Agents are picked per phase by `key` via `pickSessionAgent`.

### Runtime abstraction (`modules/runtimes`)
`RuntimeService.run(AgentRunInput)` is the single entry point for invoking an agent. It resolves the model+connection (`ModelsService.resolveForAgent`), then dispatches by `agent.runtimeType` to an adapter, wrapping every call with a timeout + retry loop + `AbortController`-based cancellation (`RUNTIME_TIMEOUT_MS`, `RUNTIME_MAX_RETRIES`). Adapters:
- `generic_llm` — OpenAI-compatible / Ollama chat completions (the default).
- `codex`, `claude_code` — spawn an external agentic-coding CLI via the shared `cli-runtime-adapter.ts`: send `AgentRunInput` as JSON on stdin, expect a `RuntimeOutput` (or `{ output, toolRequests, usage }`) on stdout. Any `toolRequests` run through `ToolExecutorService` (capability policy + workspace-root sandbox), never by the CLI directly.
- `mock` — deterministic simulation for tests/demos.

Every result is a typed `AgentRunResult` whose `output.kind` **must** match the caller's `expectedOutput.kind` (`completedOutput` throws otherwise). Adapters are real-first and safe-by-default: a disabled runtime, missing CLI, timeout, or invalid output returns a visible `failed`/`cancelled` result rather than throwing or silently mocking.

### Persistence (`modules/persistence`)
A migration-bridge JSON snapshot, not a real ORM. Services hold state in memory (`Map`s) and call `getCollection`/`setCollection`. Backend is a single JSON file under `.cache/agent-cluster/` by default, or Postgres when `AGENT_CLUSTER_PERSISTENCE_BACKEND=postgres` (writes via a spawned `pg` script). Default agents and the default model/connection are **seed-only**: re-derived from env at boot and deliberately excluded from the persisted store, so only user-created entities are saved.

### Frontend (`apps/web`, Vue 3 + Pinia)
Single-page workspace (`App.vue` → `SessionWorkspace.vue`). `src/api/client.ts` wraps REST + builds the SSE URL. Pinia stores in `src/stores/` own data: `event.ts` opens the `EventSource` and folds incoming events into timeline/derived state; `session.ts`, `agent.ts`, `model.ts`, `knowledge.ts` mirror their REST resources. `src/types/contracts.ts` is the frontend view of the shared contracts.

## Conventions & gotchas

- **ESM `.js` import specifiers.** Server (and shared) source imports sibling `.ts` files using a `.js` extension, e.g. `import { AppModule } from './app.module.js'`. Match this — `moduleResolution` is `Bundler` and the project is `"type": "module"`.
- **Nested server build output.** Because the server compiles shared *source* (via the path alias), tsc roots output at the monorepo level: the entry point is `apps/server/dist/apps/server/src/main.js`, which is what `start`/E2E runners execute.
- **`npm run dev` uses `node --watch`** and can restart mid-request (killing long runtime flows with ECONNRESET) when files in the watched tree change. For full end-to-end flows, build once and use `npm run start -w @agent-cluster/server`.
- **Real-first runtime.** Default config runs the real `generic_llm` runtime with no mock fallback (`.env.example` points at local Ollama). Mock mode is opt-in only: `MOCK_RUNTIME_ENABLED=true`, `DEFAULT_AGENT_RUNTIME_TYPE=mock`, `LLM_MOCK_FALLBACK=true`, `VITE_ENABLE_MOCKS=true`.
- **Default-agent seeding is gated.** `/api/agents` is empty unless `AGENT_CLUSTER_SEED_DEFAULT_AGENTS=true` — set it for any E2E or local run that expects the standard team.
- **High-risk tool execution is gated in depth.** Real file writes / command runs require `ENABLE_HIGH_RISK_TOOLS=true` *plus* the matching `ALLOW_FILE_WRITE_RUNTIME` / `ALLOW_COMMAND_RUNTIME` flag, *plus* a path inside `AGENT_WORKSPACE_ROOT`. Keep these off in local dev.
- **User-facing copy is Chinese.** Agent status messages, event content, and UI strings are written in Chinese; match the surrounding language.
- **Config lives in root `.env`** (loaded by `loadLocalEnv`), and Vite reads env from the repo root (`envDir`). Copy `.env.example` → `.env`.
