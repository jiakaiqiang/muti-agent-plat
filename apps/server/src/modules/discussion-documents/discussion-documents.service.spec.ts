import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  ApplyChangeSetResult,
  FileHash,
  ReadFileInput,
  ReadFileResult,
  SessionDetail,
  WorkspaceChangeSet,
  WorkspaceRevision
} from '@agent-cluster/shared';
import { ArtifactsService } from '../artifacts/artifacts.service.js';
import { EventsService } from '../events/events.service.js';
import { LocalContentStore } from '../persistence/local-content-store.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { ServerLocalWorkspaceProvider } from '../workspaces/server-local-workspace-provider.js';
import type { WorkspaceProvider } from '../workspaces/workspace-provider.js';
import type { WorkspaceProviderResolver } from '../workspaces/workspace-provider-resolver.js';
import { DiscussionDocumentsService } from './discussion-documents.service.js';

const dataEpoch = '11111111-1111-4111-8111-111111111111';

async function fixture(providerKind: 'server_local' | 'local_bridge' = 'server_local') {
  const root = await mkdtemp(join(tmpdir(), 'discussion-documents-'));
  const stateFile = join(root, 'state.json');
  await writeFile(stateFile, JSON.stringify({
    systemDataMetadata: {
      dataSchemaVersion: 3,
      dataEpoch,
      pipelineVersion: 'v2',
      cutoverAt: '2026-09-20T00:00:00.000Z',
      cutoverAuditId: 'discussion-document-test'
    }
  }), 'utf8');
  const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath: stateFile });
  await persistence.initialize();
  const session = {
    id: 'session-document',
    dataEpoch,
    title: 'Document session',
    originalInput: 'Create a plan',
    status: 'AGENT_DISCUSSING',
    ownerId: 'user-1',
    workspaceId: 'workspace-1',
    activeWorkItemId: 'work-item-1',
    tokenUsed: 0,
    participatingAgentIds: ['coordinator'],
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    workingDirectory: {
      kind: providerKind,
      id: 'workspace-1',
      name: 'workspace',
      ...(providerKind === 'server_local' ? { path: root } : {}),
      selectedAt: '2026-09-20T00:00:00.000Z'
    }
  } satisfies SessionDetail;
  await persistence.setCollection('sessions', [session]);
  await persistence.setCollection('sessionLifecyclesBySession', {
    [session.id]: { sessionId: session.id, dataEpoch, generation: 1, revision: 1, state: 'active', admission: 'open', stopStatus: 'idle' }
  });
  const provider = providerKind === 'server_local'
    ? new ServerLocalWorkspaceProvider(root)
    : new MemoryWorkspaceProvider();
  const service = new DiscussionDocumentsService(
    persistence,
    new LocalContentStore({ rootDir: join(root, 'content') }),
    { resolve: () => provider } as unknown as WorkspaceProviderResolver,
    new ArtifactsService(persistence),
    new EventsService(persistence)
  );
  return {
    root,
    stateFile,
    persistence,
    session,
    provider,
    service,
    async cleanup() {
      await persistence.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    }
  };
}

test('publishes immutable workspace files, collapses retries and supersedes the previous active version', async () => {
  const context = await fixture();
  try {
    const first = await context.service.create(context.session, {
      title: '方案', content: '# v1\n', clientMessageId: 'message-1', workItemId: 'work-item-1'
    });
    const duplicate = await context.service.create(context.session, {
      title: '方案', content: '# v1\n', clientMessageId: 'message-1', workItemId: 'work-item-1'
    });
    assert.equal(duplicate.id, first.id);
    assert.equal(context.service.list(context.session.id).length, 1);
    assert.equal(
      await readFile(join(context.root, '.agent-cluster', 'discussion-documents', context.session.id, 'plan-revision-001.md'), 'utf8'),
      '# v1\n'
    );

    const second = await context.service.create(context.session, {
      title: '方案', content: '# v2\n', clientMessageId: 'message-2', parentDocumentId: first.id, workItemId: 'work-item-1'
    });
    assert.equal(second.revision, 2);
    assert.equal(context.service.get(context.session.id, first.id).status, 'superseded');
    assert.equal(context.service.active(context.session.id)?.id, second.id);
    const published = new EventsService(context.persistence).list(context.session.id)
      .filter((event) => event.type === 'discussion_document_published');
    assert.equal(published.length, 2);
    assert.equal(JSON.stringify(published).includes('# v2'), false, 'event payload never carries Markdown content');
  } finally {
    await context.cleanup();
  }
});

test('restores the active document, content and read receipt from file persistence after restart', async () => {
  const context = await fixture();
  let reopenedPersistence: PersistenceService | undefined;
  try {
    const document = await context.service.create(context.session, {
      title: 'Restart plan', content: '# persisted\n', clientMessageId: 'restart-message'
    });
    await context.service.recordAgentRead({
      sessionId: context.session.id,
      documentId: document.id,
      agentId: 'coordinator',
      invocationId: 'restart-invocation',
      relativePath: document.relativePath
    });
    await context.persistence.onModuleDestroy();

    reopenedPersistence = new PersistenceService({
      enabled: true,
      backend: 'file',
      filePath: context.stateFile
    });
    await reopenedPersistence.initialize();
    const reopened = new DiscussionDocumentsService(
      reopenedPersistence,
      new LocalContentStore({ rootDir: join(context.root, 'content') }),
      { resolve: () => new ServerLocalWorkspaceProvider(context.root) } as unknown as WorkspaceProviderResolver,
      new ArtifactsService(reopenedPersistence),
      new EventsService(reopenedPersistence)
    );

    assert.equal(reopened.active(context.session.id)?.id, document.id);
    assert.equal(reopened.content(context.session.id, document.id).content, '# persisted\n');
    assert.equal(
      reopened.hasCompleteReceipt(document.id, 'coordinator', 'restart-invocation'),
      true
    );
  } finally {
    await reopenedPersistence?.onModuleDestroy();
    await context.persistence.onModuleDestroy();
    await rm(context.root, { recursive: true, force: true });
  }
});

test('does not expose an active document from a superseded session data epoch', async () => {
  const context = await fixture();
  try {
    const document = await context.service.create(context.session, {
      title: 'Epoch plan', content: '# old epoch\n', clientMessageId: 'epoch-message'
    });
    const nextEpoch = '22222222-2222-4222-8222-222222222222';
    await context.persistence.setCollection('sessions', [{ ...context.session, dataEpoch: nextEpoch }]);
    assert.equal(context.service.active(context.session.id), undefined);
    assert.deepEqual(context.service.list(context.session.id), []);
    assert.throws(() => context.service.content(context.session.id, document.id), /not found/i);
  } finally {
    await context.cleanup();
  }
});

test('records a complete Agent receipt and fails closed after the workspace file changes', async () => {
  const context = await fixture();
  try {
    const document = await context.service.create(context.session, {
      title: 'Plan', content: '# trusted\n', clientMessageId: 'message-1'
    });
    const receipt = await context.service.recordAgentRead({
      sessionId: context.session.id,
      documentId: document.id,
      agentId: 'coordinator',
      invocationId: 'invocation-1',
      relativePath: document.relativePath
    });
    assert.equal(receipt.status, 'completed');
    assert.equal(context.service.hasCompleteReceipt(document.id, 'coordinator', 'invocation-1'), true);

    await writeFile(join(context.root, document.relativePath), '# modified externally\n', 'utf8');
    const failed = await context.service.recordAgentRead({
      sessionId: context.session.id,
      documentId: document.id,
      agentId: 'coordinator',
      invocationId: 'invocation-2',
      relativePath: document.relativePath
    });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCode, 'DOCUMENT_READ_HASH_MISMATCH');
    assert.equal(context.service.hasCompleteReceipt(document.id, 'coordinator', 'invocation-2'), false);
  } finally {
    await context.cleanup();
  }
});

test('uses the WorkspaceProvider contract for a local_bridge workspace without a server path', async () => {
  const context = await fixture('local_bridge');
  try {
    const document = await context.service.create(context.session, {
      title: 'Bridge plan', content: '# bridge\n', clientMessageId: 'bridge-message'
    });
    assert.equal(document.status, 'active');
    assert.equal((await context.provider.readFile({ path: document.relativePath })).content, '# bridge\n');
    const receipt = await context.service.recordAgentRead({
      sessionId: context.session.id,
      documentId: document.id,
      agentId: 'coordinator',
      invocationId: 'bridge-invocation',
      relativePath: document.relativePath
    });
    assert.equal(receipt.status, 'completed');
  } finally {
    await context.cleanup();
  }
});

test('rejects a concurrent branch from a superseded parent while preserving idempotent replay', async () => {
  const context = await fixture();
  try {
    const first = await context.service.create(context.session, {
      title: 'Plan', content: '# v1\n', clientMessageId: 'message-v1'
    });
    const [accepted, rejected] = await Promise.allSettled([
      context.service.create(context.session, {
        title: 'Plan', content: '# v2-a\n', clientMessageId: 'message-v2-a', parentDocumentId: first.id
      }),
      context.service.create(context.session, {
        title: 'Plan', content: '# v2-b\n', clientMessageId: 'message-v2-b', parentDocumentId: first.id
      })
    ]);
    assert.equal(accepted.status, 'fulfilled');
    assert.equal(rejected.status, 'rejected');
    assert.match(String(rejected.status === 'rejected' ? rejected.reason : ''), /DISCUSSION_DOCUMENT_STALE_PARENT/);
    assert.equal(context.service.list(context.session.id).length, 2);

    const replay = await context.service.create(context.session, {
      title: 'Plan', content: '# v2-a\n', clientMessageId: 'message-v2-a', parentDocumentId: first.id
    });
    assert.equal(replay.id, accepted.status === 'fulfilled' ? accepted.value.id : undefined);
  } finally {
    await context.cleanup();
  }
});

test('rejects oversized and binary content before reserving a version', async () => {
  const context = await fixture();
  try {
    await assert.rejects(
      context.service.create(context.session, {
        title: 'Large plan', content: 'x'.repeat(200_001), clientMessageId: 'too-large'
      }),
      /DISCUSSION_DOCUMENT_TOO_LARGE/
    );
    await assert.rejects(
      context.service.create(context.session, {
        title: 'Binary plan', content: '# plan\0payload', clientMessageId: 'binary'
      }),
      /DISCUSSION_DOCUMENT_BINARY_UNSUPPORTED/
    );
    assert.equal(context.service.list(context.session.id).length, 0);
  } finally {
    await context.cleanup();
  }
});

class MemoryWorkspaceProvider implements WorkspaceProvider {
  readonly kind = 'local_bridge' as const;
  private revision = 0;
  private readonly files = new Map<string, string>();

  capabilities() { return { read: true, write: true, command: false, test: false }; }
  async getRevision(): Promise<WorkspaceRevision> { return this.currentRevision(); }
  async listDirectory() { return { path: '', entries: [], revision: this.currentRevision() }; }
  async statFile(input: { path: string }) {
    const content = this.files.get(input.path);
    if (content === undefined) throw new Error('WORKSPACE_FILE_NOT_FOUND');
    return { path: input.path, kind: 'file' as const, size: Buffer.byteLength(content), hash: hash(content), revision: this.currentRevision() };
  }
  async readFile(input: ReadFileInput): Promise<ReadFileResult> {
    const content = this.files.get(input.path);
    if (content === undefined) throw new Error('WORKSPACE_FILE_NOT_FOUND');
    return { path: input.path, content, encoding: 'utf-8', byteLength: Buffer.byteLength(content), truncated: false, hash: hash(content), revision: this.currentRevision() };
  }
  async searchText() { return { matches: [], truncated: false, revision: this.currentRevision() }; }
  async applyChangeSet(input: WorkspaceChangeSet): Promise<ApplyChangeSetResult> {
    for (const change of input.changes) {
      if (change.operation !== 'create') throw new Error('UNSUPPORTED');
      if (this.files.has(change.path)) return { ok: false, changeSetId: input.id, revision: this.currentRevision(), conflicts: [] };
      this.files.set(change.path, change.content);
    }
    this.revision += 1;
    return { ok: true, changeSetId: input.id, revision: this.currentRevision(), appliedCount: input.changes.length };
  }
  private currentRevision(): WorkspaceRevision {
    return { id: `bridge-${this.revision}`, observedAt: '2026-09-20T00:00:00.000Z' };
  }
}

function hash(content: string): FileHash {
  return { algorithm: 'sha256', value: digest(content) };
}

function digest(content: string) {
  return createHash('sha256').update(content).digest('hex') as string;
}
