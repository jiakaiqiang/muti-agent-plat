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
2. Build the event stream, mock runtime, and three-column chat workspace first.
3. Use dry-run execution until the collaboration loop is verified.
4. Add real Codex/Claude Code runtimes in v2.

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
Notification Agent. It is a dry-run draft only: no external Feishu message is
sent until a future explicit send/confirmation flow is added.
