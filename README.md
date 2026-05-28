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
