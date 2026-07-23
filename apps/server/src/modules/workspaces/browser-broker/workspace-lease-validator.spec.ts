import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceLease, WorkspaceOperationKind } from '@agent-cluster/shared';
import {
  validateWorkspaceLease,
  WorkspaceLeaseUnauthorizedError
} from './workspace-lease-validator.js';

function makeLease(overrides: Partial<WorkspaceLease> = {}): WorkspaceLease {
  return {
    leaseId: '00000000-0000-4000-8000-000000000001',
    workspaceId: 'ws-1',
    mode: 'read_write',
    allowedOperations: ['listDirectory', 'readFile', 'applyChangeSet'],
    issuedAt: '2026-07-12T00:00:00.000Z',
    expiresAt: '2026-07-12T00:10:00.000Z',
    issuedBySessionId: '00000000-0000-4000-8000-000000000002',
    ...overrides
  };
}

test('validateWorkspaceLease returns ok for a fresh lease covering the requested op', () => {
  const lease = makeLease();
  const result = validateWorkspaceLease({
    lease,
    operation: 'readFile',
    now: new Date('2026-07-12T00:05:00.000Z')
  });
  assert.equal(result.ok, true);
});

test('validateWorkspaceLease returns unauthorized for an expired lease', () => {
  const lease = makeLease({ expiresAt: '2026-07-12T00:01:00.000Z' });
  const result = validateWorkspaceLease({
    lease,
    operation: 'readFile',
    now: new Date('2026-07-12T00:05:00.000Z')
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'WORKSPACE_LEASE_UNAUTHORIZED');
  assert.match(result.reason, /expired/i);
});

test('validateWorkspaceLease returns unauthorized when operation is not in allowedOperations', () => {
  const lease = makeLease({ allowedOperations: ['listDirectory', 'readFile'] });
  const result = validateWorkspaceLease({
    lease,
    operation: 'applyChangeSet',
    now: new Date('2026-07-12T00:05:00.000Z')
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /operation/i);
});

test('validateWorkspaceLease returns unauthorized when applyChangeSet requested on a read-only lease', () => {
  const lease = makeLease({
    mode: 'read',
    allowedOperations: ['listDirectory', 'readFile', 'applyChangeSet' as WorkspaceOperationKind]
  });
  const result = validateWorkspaceLease({
    lease,
    operation: 'applyChangeSet',
    now: new Date('2026-07-12T00:05:00.000Z')
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /read.only|write/i);
});

test('WorkspaceLeaseUnauthorizedError carries the reason and code for HTTP mapping', () => {
  const error = new WorkspaceLeaseUnauthorizedError('lease expired');
  assert.equal(error.code, 'WORKSPACE_LEASE_UNAUTHORIZED');
  assert.match(error.message, /lease expired/);
});
