# Agent Cluster

Agent Cluster is a multi-agent collaboration system. The v1 implementation follows the contracts in [docs/contracts](./docs/contracts) and the phased implementation plan in [docs/agent-team-implementation-breakdown-v1.md](./docs/agent-team-implementation-breakdown-v1.md).

## Workspace

- `apps/server`: NestJS backend.
- `apps/web`: Vue 3 frontend.
- `packages/shared`: shared TypeScript contract types.
- `tests`: contract and E2E test skeletons.
- `docs`: PRD, system design, contracts, QA, and operations docs.

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
LLM_API_KEY=
LLM_BASE_URL=http://127.0.0.1:11434/v1
```

For an OpenAI-compatible cloud provider, use its real API key and base URL:

```env
LLM_PROVIDER=openai-compatible
LLM_MODEL=gpt-4.1-mini
LLM_API_KEY=sk-...
LLM_BASE_URL=https://api.openai.com/v1
```

For local demos or E2E tests, explicitly enable mock mode with
`VITE_ENABLE_MOCKS=true`, `DEFAULT_AGENT_RUNTIME_TYPE=mock`,
`LLM_MOCK_FALLBACK=true`, and `MOCK_RUNTIME_ENABLED=true`.

## Agentic Coding Runtimes (v2)

The `codex` and `claude_code` runtimes execute through an external agentic
coding CLI. Each adapter spawns the configured CLI, sends the `AgentRunInput`
as JSON on stdin, and expects a JSON response on stdout — either a bare
`RuntimeOutput` or `{ output, toolRequests, usage }`. They are real-first and
safe-by-default: when the runtime is disabled or the CLI is missing they return
a visible failed result instead of crashing.

```env
CODEX_RUNTIME_ENABLED=false
CODEX_CLI_COMMAND=codex
CODEX_CLI_ARGS=
CLAUDE_CODE_RUNTIME_ENABLED=false
CLAUDE_CODE_CLI_COMMAND=claude
CLAUDE_CODE_CLI_ARGS=
```

Any `toolRequests` the CLI declares run through the controlled
`ToolExecutorService` (`file_write`, `command_run`, `run_test`, `git_diff`),
never by the CLI process directly. Tool execution is gated in depth: the
capability policy first, then the dedicated `ALLOW_FILE_WRITE_RUNTIME` /
`ALLOW_COMMAND_RUNTIME` flags, then `ENABLE_HIGH_RISK_TOOLS`, plus a
workspace-root sandbox that rejects any path escaping `AGENT_WORKSPACE_ROOT`.
Every run is bounded by `RUNTIME_TIMEOUT_MS` and retried up to
`RUNTIME_MAX_RETRIES` times for retryable errors; in-flight runs can be
cancelled, which kills the spawned process. See `npm run test:e2e:v2-runtime`
for an end-to-end example using a fake CLI.

```env
ENABLE_HIGH_RISK_TOOLS=false
ALLOW_FILE_WRITE_RUNTIME=false
ALLOW_COMMAND_RUNTIME=false
AGENT_WORKSPACE_ROOT=
RUNTIME_TIMEOUT_MS=60000
RUNTIME_MAX_RETRIES=2
```

## Local Runtime State

The server now keeps a JSON persistence snapshot for local development. By
default it writes to `.cache/agent-cluster/state.v0.1.json`; override this with
`AGENT_CLUSTER_DATA_DIR` or `AGENT_CLUSTER_DATA_FILE`, or set
`AGENT_CLUSTER_PERSISTENCE=false` to run fully in memory. This is a migration
bridge, not the final PostgreSQL storage layer.

High-risk capabilities are policy-gated before any future real tool execution.
Use `/api/capabilities` to inspect registered capabilities and
`/api/capabilities/:capabilityId/check` before invoking one. Local development
keeps `ENABLE_HIGH_RISK_TOOLS=false` and `REQUIRE_USER_CONFIRMATION=true` by
default.

Final delivery also creates a local `feishu_draft` artifact through the
Notification Agent. It remains a draft artifact only: no external Feishu
message is sent until a future explicit send/confirmation flow is added.
