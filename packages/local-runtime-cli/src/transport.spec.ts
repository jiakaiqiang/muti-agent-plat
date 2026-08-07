import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  authorizeLoopbackDevice,
  initializeSelectedWorkspace,
  LocalWritebackAuthorizationStore,
  workspaceRegistration
} from './transport.js';
import { defaultState } from './state.js';
import { LocalWorkspace } from './workspace.js';
import { probeLocalRuntimeCapabilities } from './adapters/registry.js';

test('Runtime capability probe reports each installed CLI without starting a model process', async () => {
  const previousCodexVersion = process.env.AGENT_RUNTIME_CODEX_VERSION;
  const previousClaudeVersion = process.env.AGENT_RUNTIME_CLAUDE_VERSION;
  process.env.AGENT_RUNTIME_CODEX_VERSION = 'codex-test 1.0';
  process.env.AGENT_RUNTIME_CLAUDE_VERSION = 'claude-test 2.0';
  try {
    const capabilities = await probeLocalRuntimeCapabilities();
    assert.deepEqual(capabilities.map(({ runtimeType, status, version }) => ({ runtimeType, status, version })), [
      { runtimeType: 'codex', status: 'ready', version: 'codex-test 1.0' },
      { runtimeType: 'claude_code', status: 'ready', version: 'claude-test 2.0' }
    ]);
  } finally {
    if (previousCodexVersion === undefined) delete process.env.AGENT_RUNTIME_CODEX_VERSION;
    else process.env.AGENT_RUNTIME_CODEX_VERSION = previousCodexVersion;
    if (previousClaudeVersion === undefined) delete process.env.AGENT_RUNTIME_CLAUDE_VERSION;
    else process.env.AGENT_RUNTIME_CLAUDE_VERSION = previousClaudeVersion;
  }
});

test('loopback authorization stores a trusted device token without login', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-runtime-loopback-'));
  const stateFile = join(directory, 'state.json');
  const previousStateFile = process.env.AGENT_RUNTIME_STATE_FILE;
  const previousCodexVersion = process.env.AGENT_RUNTIME_CODEX_VERSION;
  const previousClaudeVersion = process.env.AGENT_RUNTIME_CLAUDE_VERSION;
  const previousFetch = globalThis.fetch;
  let advertisedRuntimes: Record<string, string> | undefined;
  process.env.AGENT_RUNTIME_STATE_FILE = stateFile;
  process.env.AGENT_RUNTIME_CODEX_VERSION = 'codex-test 1.0';
  process.env.AGENT_RUNTIME_CLAUDE_VERSION = 'claude-test 2.0';
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { deviceId: string; runtimes: Record<string, string> };
    advertisedRuntimes = body.runtimes;
    return new Response(JSON.stringify({
      data: {
        deviceId: body.deviceId,
        accessToken: 'access-token',
        accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
        refreshToken: 'refresh-token',
        refreshTokenExpiresAt: '2099-02-01T00:00:00.000Z'
      },
      requestId: 'request-loopback-auth'
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const state = defaultState('http://127.0.0.1:8099');
    await authorizeLoopbackDevice(state, '0.1.0');
    assert.equal(state.tokens?.accessToken, 'access-token');
    assert.match(await readFile(stateFile, 'utf8'), /access-token/);
    assert.deepEqual(advertisedRuntimes, {
      codex: 'codex-test 1.0',
      claude_code: 'claude-test 2.0'
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStateFile === undefined) delete process.env.AGENT_RUNTIME_STATE_FILE;
    else process.env.AGENT_RUNTIME_STATE_FILE = previousStateFile;
    if (previousCodexVersion === undefined) delete process.env.AGENT_RUNTIME_CODEX_VERSION;
    else process.env.AGENT_RUNTIME_CODEX_VERSION = previousCodexVersion;
    if (previousClaudeVersion === undefined) delete process.env.AGENT_RUNTIME_CLAUDE_VERSION;
    else process.env.AGENT_RUNTIME_CLAUDE_VERSION = previousClaudeVersion;
    await rm(directory, { recursive: true, force: true });
  }
});

test('cancelled workspace initialization leaves no workspace state, watcher or index work behind', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-runtime-cancelled-workspace-'));
  const state = defaultState('http://127.0.0.1:8099');
  const workspaces = new Map<string, LocalWorkspace>();
  const tails = new Map<string, Promise<void>>();
  const controller = new AbortController();

  try {
    const initialization = initializeSelectedWorkspace(
      directory,
      state,
      workspaces,
      tails,
      controller.signal
    );
    controller.abort(new Error('dialog closed'));

    await assert.rejects(initialization, /dialog closed/);
    assert.equal(state.workspaces.length, 0);
    assert.equal(workspaces.size, 0);
    assert.equal(tails.size, 0);
  } finally {
    for (const workspace of workspaces.values()) workspace.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('workspace registration returns an index summary without serializing index entries', async () => {
  const revision = { id: 'revision-1', observedAt: '2026-07-28T00:00:00.000Z' };
  const workspace = new LocalWorkspace({
    workspaceId: 'workspace-1', displayName: 'large-project', rootPath: 'D:/large-project',
    permissions: {
      workspace_read: 'allow', workspace_write: 'allow', workspace_delete: 'confirm',
      command_execute: 'allow', test_execute: 'allow', dependency_install: 'confirm'
    },
    permissionPolicyVersion: 2,
    registeredAt: '2026-07-28T00:00:00.000Z',
    index: {
      workspaceId: 'workspace-1', revision, generation: 7, status: 'ready', complete: true,
      entries: Array.from({ length: 1_000 }, (_, index) => ({
        path: `src/file-${index}.ts`, kind: 'file' as const, size: 1, generated: false, sensitive: false
      })),
      entrypoints: ['src/file-0.ts'], detectedStack: ['node'], indexedEntries: 100_000,
      truncated: false, updatedAt: revision.observedAt,
      coverage: {
        visitedEntries: 100_000,
        indexedEntries: 100_000,
        excludedGenerated: 0,
        sensitiveEntries: 0,
        skippedSymlinks: 0,
        failedEntries: 0
      }
    }
  }, { watch: false, index: false });

  const registration = await workspaceRegistration(workspace);

  assert.equal(registration.index?.indexedEntries, 100_000);
  assert.equal('entries' in (registration.index ?? {}), false);
  workspace.close();
});

test('one-time delete authorization is bound to one ChangeSet and consumed only after apply succeeds', () => {
  let now = 1_000;
  const authorizations = new LocalWritebackAuthorizationStore(100, () => now);
  const base = {
    workspace_read: 'allow', workspace_write: 'allow', workspace_delete: 'confirm',
    command_execute: 'allow', test_execute: 'allow', dependency_install: 'confirm'
  } as const;
  const request = {
    kind: 'local_runtime.workspace.operation.request' as const,
    payload: {
      requestId: 'request-delete', invocationId: 'invocation-delete', ownerId: 'local-user',
      workspaceId: 'workspace-delete', workspaceRevision: { id: 'revision-delete', observedAt: '2026-07-30T00:00:00.000Z' },
      permissions: base, operation: 'applyChangeSet' as const,
      input: {
        id: 'changes-delete', baseRevision: { id: 'revision-delete', observedAt: '2026-07-30T00:00:00.000Z' },
        changes: [], createdAt: '2026-07-30T00:00:00.000Z'
      }
    }
  }.payload;

  authorizations.authorizeDelete(request.workspaceId, request.input);
  assert.equal(authorizations.permissionsFor(request, base).workspace_delete, 'allow');
  assert.equal(authorizations.permissionsFor({ ...request, input: { ...request.input, id: 'other' } }, base).workspace_delete, 'confirm');
  assert.equal(authorizations.permissionsFor({
    ...request,
    input: { ...request.input, changes: [{ operation: 'delete' as const, path: 'other.txt', expectedHash: { algorithm: 'sha256' as const, value: 'different' } }] }
  }, base).workspace_delete, 'confirm');
  authorizations.recordApplyResult(request, {
    ok: false, changeSetId: request.input.id, revision: request.workspaceRevision, conflicts: []
  });
  assert.equal(authorizations.permissionsFor(request, base).workspace_delete, 'allow');
  authorizations.recordApplyResult(request, {
    ok: true, changeSetId: request.input.id, revision: request.workspaceRevision, appliedCount: 0
  });
  assert.equal(authorizations.permissionsFor(request, base).workspace_delete, 'confirm');

  authorizations.authorizeDelete(request.workspaceId, request.input);
  now += 101;
  assert.equal(authorizations.permissionsFor(request, base).workspace_delete, 'confirm');
});
