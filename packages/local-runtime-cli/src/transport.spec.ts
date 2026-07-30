import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authorizeLoopbackDevice, workspaceRegistration } from './transport.js';
import { defaultState } from './state.js';
import { LocalWorkspace } from './workspace.js';

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
      truncated: false, updatedAt: revision.observedAt
    }
  }, { watch: false, index: false });

  const registration = await workspaceRegistration(workspace);

  assert.equal(registration.index?.indexedEntries, 100_000);
  assert.equal('entries' in (registration.index ?? {}), false);
  workspace.close();
});
