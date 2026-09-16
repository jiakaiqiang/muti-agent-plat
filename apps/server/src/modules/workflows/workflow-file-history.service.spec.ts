import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AgentTask, Artifact, WorkflowRun, WorkspaceChange } from '@agent-cluster/shared';
import { buildDeliveryFileDiff, WorkflowFileHistoryService } from './workflow-file-history.service.js';
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
const run: WorkflowRun = {
  id: 'run', sessionId: 's', status: 'completed', completedAt: '2026-09-11T12:00:00Z',
  workflowId: 'workflow', workflowVersion: 1, workflowName: 'Delivery', briefId: 'brief', ownerId: 'owner',
  revision: 1, runtimeVersion: 'v2', startIdempotencyKey: 's:confirmation', createdAt: '2026-09-11T10:00:00Z', updatedAt: '2026-09-11T12:00:00Z',
  definitionSnapshot: { id: 'version', workflowId: 'workflow', version: 1, name: 'Delivery', nodes: [], edges: [], involvedAgentIds: [], definitionHash: 'definition', publishedBy: 'owner', publishedAt: '2026-09-11T09:00:00Z' },
  fileBaseline: { complete: true, capturedAt: '2026-09-11T10:00:00Z', hashes: { 'a.ts': hash('original') } }
};
const task = (id: string) => ({ id, sessionId: 's', workflowRunId: 'run', status: 'completed' } as AgentTask);
const artifact = (id: string, changes: WorkspaceChange[]) => ({ id, sessionId: 's', taskId: id, createdAt: `2026-09-11T10:0${id}:00Z`, systemEvidence: { capturedAt: `2026-09-11T10:0${id}:00Z`, workspaceChangeSet: { id, changes } } } as Artifact);
const update = (before: string, after: string): WorkspaceChange => ({ operation: 'update', path: 'a.ts', baseContent: before, content: after, encoding: 'utf-8', expectedHash: { algorithm: 'sha256', value: hash(before) } });

test('delivery compares the run baseline with final content, cancelling reverted edits', () => {
  const result = buildDeliveryFileDiff(run, [task('1'), task('2')], [artifact('1', [update('original', 'middle')]), artifact('2', [update('middle', 'original')])]);
  assert.equal(result.status, 'complete'); assert.deepEqual(result.files, []);
  const changed = buildDeliveryFileDiff(run, [task('1'), task('2')], [artifact('1', [update('original', 'middle')]), artifact('2', [update('middle', 'final')])]);
  assert.deepEqual(changed.files, [{ path: 'a.ts', before: 'original', after: 'final', operation: 'update' }]);
});
test('missing baselines, unknown attempts and discontinuous evidence never produce a fabricated diff', () => {
  assert.equal(buildDeliveryFileDiff({ ...run, fileBaseline: undefined }, [], []).status, 'unavailable');
  assert.equal(buildDeliveryFileDiff(run, [task('1')], []).status, 'unavailable');
  assert.equal(buildDeliveryFileDiff(run, [{ ...task('1'), status: 'cancelled' }], []).status, 'unavailable');
  assert.equal(buildDeliveryFileDiff(run, [task('1')], [artifact('1', [update('external edit', 'final')])]).status, 'unavailable');
});
test('deduplicates shared ChangeSets and excludes other workflows and later artifacts', () => {
  const first = artifact('1', [update('original', 'final')]);
  const late = { ...artifact('2', [update('final', 'later')]), createdAt: '2026-09-12T00:00:00Z' };
  const result = buildDeliveryFileDiff(run, [task('1')], [first, { ...first, id: 'copy' }, late, { ...first, sessionId: 'other' }]);
  assert.equal(result.files[0]?.after, 'final');
});
test('create-delete empty files are tracked by existence, not merely text equality', () => {
  const baseline = { ...run, fileBaseline: { ...run.fileBaseline!, hashes: {} } };
  const create: WorkspaceChange = { operation: 'create', path: 'empty', content: '', encoding: 'utf-8' };
  assert.equal(buildDeliveryFileDiff(baseline, [task('1')], [artifact('1', [create])]).files[0]?.operation, 'create');
  const remove: WorkspaceChange = { operation: 'delete', path: 'empty', baseContent: '', expectedHash: { algorithm: 'sha256', value: hash('') } };
  assert.deepEqual(buildDeliveryFileDiff(baseline, [task('1'),task('2')], [artifact('1',[create]),artifact('2',[remove])]).files, []);
});
test('baseline capture marks pagination gaps unavailable instead of assuming missing files absent', async () => {
  const service = new WorkflowFileHistoryService({ resolve: () => ({ listDirectory: async () => ({ entries: [], nextCursor: 'more' }) }) } as never, {} as never, {} as never);
  const baseline = await service.captureBaseline({} as never);
  assert.equal(baseline.complete, false); assert.match(baseline.reason!, /上限/);
});
