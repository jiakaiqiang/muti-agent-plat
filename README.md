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
