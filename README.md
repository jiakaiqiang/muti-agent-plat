# Agent Cluster

Agent Cluster is a multi-agent collaboration system. The v1 implementation follows the contracts in [docs/contracts](./docs/contracts) and the phased implementation plan in [docs/implementation/agent-team-implementation-breakdown-v1.md](./docs/implementation/agent-team-implementation-breakdown-v1.md).

## Workspace

- `apps/server`: NestJS backend.
- `apps/web`: Vue 3 frontend.
- `packages/shared`: shared TypeScript contract types.
- `tests`: contract and E2E test skeletons.
- `docs`: classified product, design, analysis, contracts, QA, and operations docs. Start with [docs/README.md](./docs/README.md).

## Development Order

1. Keep the v0.1 contracts stable.
2. Keep the event stream and three-column chat workspace contract-compatible.
3. Run agents through the configured `generic_llm` runtime by default.
4. Use mock runtime only when an explicit local demo/test mode enables it.

## Runtime Configuration

Runtime execution is real-first by default. Copy `.env.example` to `.env` and
keep `DEFAULT_AGENT_RUNTIME_TYPE=generic_llm`, `LLM_DRY_RUN=false`, and
`LLM_MOCK_FALLBACK=false`. If the LLM configuration is missing or unreachable,
the runtime fails visibly instead of silently returning mock data.

Local Ollama is supported through Ollama's OpenAI-compatible endpoint:

```env
LLM_PROVIDER=ollama
LLM_MODEL=llama3.2
LLM_MODEL_OPTIONS=llama3.2,qwen2.5,mistral,deepseek-r1
LLM_API_KEY=
LLM_BASE_URL=http://127.0.0.1:11434/v1
```

For an OpenAI-compatible cloud provider, use its real API key and base URL:

```env
LLM_PROVIDER=openai-compatible
LLM_MODEL=gpt-4.1-mini
LLM_MODEL_OPTIONS=gpt-4.1-mini,gpt-4.1,gpt-4o-mini,gpt-4o
LLM_API_KEY=sk-...
LLM_BASE_URL=https://api.openai.com/v1
```

The web app's model management page can switch the active `generic_llm`
model at runtime. The switch is persisted in the configured local state backend
and applies to subsequent runtime calls; in-flight calls keep the model they
started with.

For local demos or E2E tests, explicitly enable mock mode with
`VITE_ENABLE_MOCKS=true`, `DEFAULT_AGENT_RUNTIME_TYPE=mock`,
`LLM_MOCK_FALLBACK=true`, and `MOCK_RUNTIME_ENABLED=true`.

## Local Runtime State

The server supports both local file persistence and PostgreSQL persistence.
With `AGENT_CLUSTER_PERSISTENCE_BACKEND=file`, it writes a JSON snapshot to
`.cache/agent-cluster/state.v0.1.json`; override this with
`AGENT_CLUSTER_DATA_DIR` or `AGENT_CLUSTER_DATA_FILE`. With
`AGENT_CLUSTER_PERSISTENCE_BACKEND=postgres`, it uses a `pg.Pool`, loads
collections on startup, and upserts changed collections through the configured
`AGENT_CLUSTER_POSTGRES_COLLECTION_TABLE`.

Session creation and brief confirmation are accepted immediately. The Agent
discussion, task execution, post-review, and final delivery happen in the
background; clients should follow `/api/sessions/:sessionId/events/stream` or
poll `/api/sessions/:sessionId/events` for progress.

When `ENABLE_BULLMQ=false`, `ExecutionService` runs the pipeline in-process and
`RecoveryService` can re-drive interrupted `EXECUTING` sessions on boot
(`AGENT_CLUSTER_RECOVER_ON_BOOT=true`). When `ENABLE_BULLMQ=true`, confirmed
briefs enqueue `agent-task-queue` jobs and the in-process BullMQ worker consumes
them with `QUEUE_ATTEMPTS` and `QUEUE_CONCURRENCY`.

Runtime dispatch uses an explicit registry. `mock` and `generic_llm` execute
when configured; reserved or unsupported runtime types such as `codex`,
`claude_code`, `mcp_tool`, and `human` fail visibly and are recorded in runtime
invocation logs instead of silently falling back to mock output.

Multi-agent discussion is controlled by `DISCUSSION_AGENT_KEYS`,
`DISCUSSION_MAX_ROUNDS`, and `DISCUSSION_TIMEOUT_MS`. A discussion timeout is
recorded as a risk message and a `RUNTIME_TIMEOUT` invocation, then brief
generation continues. If a local model is too slow during brief creation, set
`DISCUSSION_MAX_ROUNDS=0` to skip pre-brief discussion temporarily, or reduce
`DISCUSSION_AGENT_KEYS` to fewer agents. Token accounting uses estimated counts
by default and updates `session.tokenUsed` after runtime calls;
`TOKEN_BUDGET_DEFAULT` provides the fallback budget for sessions without an
explicit `tokenBudget`.

Preference-style messages request confirmation before writing long-term memory.
Confirm candidates through `POST /api/sessions/:sessionId/memories/confirm`;
manual session memories can still be created with `POST /api/sessions/:sessionId/memories`.

High-risk capabilities are policy-gated before any future real tool execution.
Use `/api/capabilities` to inspect registered capabilities and
`/api/capabilities/:capabilityId/check` before invoking one. Local development
keeps `ENABLE_HIGH_RISK_TOOLS=false` and `REQUIRE_USER_CONFIRMATION=true` by
default.

Final delivery also creates a local `feishu_draft` artifact through the
Notification Agent. It remains a draft artifact only: no external Feishu
message is sent until a future explicit send/confirmation flow is added.
