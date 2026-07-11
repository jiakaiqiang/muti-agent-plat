import { randomUUID } from 'node:crypto';
import type { WorkspaceRevision } from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';

export function createWorkspaceRevision(): WorkspaceRevision {
  return {
    id: `rev-${randomUUID()}`,
    observedAt: nowIso()
  };
}
