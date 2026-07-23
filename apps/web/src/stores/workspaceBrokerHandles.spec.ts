import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkspaceHandleRegistry,
  type WorkspaceHandleRecord
} from './workspaceBrokerHandles';

function record(id: string, workspaceId = 'ws-93'): WorkspaceHandleRecord {
  return {
    handleId: id,
    workspaceId,
    displayName: `handle-${id}`,
    registeredAt: '2026-07-11T00:00:00.000Z'
  };
}

test('WorkspaceHandleRegistry registers a handle and returns it via get() and has()', () => {
  const registry = new WorkspaceHandleRegistry<{ marker: string }>();
  registry.register(record('h1'), { marker: 'a' });
  assert.equal(registry.has('h1'), true);
  const entry = registry.get('h1');
  assert.equal(entry?.record.workspaceId, 'ws-93');
  assert.equal(entry?.handle.marker, 'a');
});

test('WorkspaceHandleRegistry returns undefined for unknown handleId', () => {
  const registry = new WorkspaceHandleRegistry();
  assert.equal(registry.get('nope'), undefined);
  assert.equal(registry.has('nope'), false);
});

test('WorkspaceHandleRegistry drop reports removal and clears the entry', () => {
  const registry = new WorkspaceHandleRegistry();
  registry.register(record('h2'), {});
  assert.equal(registry.drop('h2'), true);
  assert.equal(registry.drop('h2'), false);
  assert.equal(registry.has('h2'), false);
});

test('WorkspaceHandleRegistry list returns all registered records', () => {
  const registry = new WorkspaceHandleRegistry();
  registry.register(record('h1'), {});
  registry.register(record('h2'), {});
  const ids = registry.list().map((r) => r.handleId).sort();
  assert.deepEqual(ids, ['h1', 'h2']);
});

test('WorkspaceHandleRegistry clear empties the registry', () => {
  const registry = new WorkspaceHandleRegistry();
  registry.register(record('h1'), {});
  registry.clear();
  assert.deepEqual(registry.list(), []);
});
