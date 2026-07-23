import { describe, expect, it } from 'vitest'
import type { ArtifactEventPayload } from '@/types/contracts'
import {
  applicableArtifactFileChanges,
  observedArtifactFileChanges,
  platformArtifactProjections
} from './artifactFileChangeModel'

function payload(overrides: Partial<ArtifactEventPayload> = {}): ArtifactEventPayload {
  return {
    artifactId: 'artifact-1',
    type: 'json',
    title: 'artifact',
    ...overrides
  }
}

describe('artifact file-change domains', () => {
  it('keeps platform projections separate from observed system evidence', () => {
    const value = payload({
      platformProjections: [{ path: 'draft.md', operation: 'create', content: 'draft' }],
      systemEvidence: {
        workspaceChangeSet: {
          id: 'change-set-1',
          changes: [{ path: 'actual.md', operation: 'create', content: 'actual', encoding: 'utf-8' }]
        },
        verifiedTestResults: [],
        capturedAt: '2026-07-15T00:00:00.000Z',
        invocationId: 'invocation-1'
      }
    })

    expect(platformArtifactProjections(value).map((change) => change.path)).toEqual(['draft.md'])
    expect(observedArtifactFileChanges(value)).toEqual([
      {
        path: 'actual.md',
        operation: 'create',
        content: 'actual',
        encoding: 'utf-8',
        source: 'actual_filesystem_snapshot'
      }
    ])
    expect(applicableArtifactFileChanges(value).map((change) => change.path)).toEqual(['draft.md', 'actual.md'])
  })

  it('lets observed evidence win when both domains mention the same path', () => {
    const value = payload({
      platformProjections: [{ path: 'same.md', operation: 'create', content: 'planned' }],
      systemEvidence: {
        workspaceChangeSet: {
          id: 'change-set-2',
          changes: [{ path: 'same.md', operation: 'create', content: 'observed', encoding: 'utf-8' }]
        },
        verifiedTestResults: [],
        capturedAt: '2026-07-15T00:00:00.000Z',
        invocationId: 'invocation-2'
      }
    })

    expect(applicableArtifactFileChanges(value)).toEqual([
      {
        path: 'same.md',
        operation: 'create',
        content: 'observed',
        encoding: 'utf-8',
        source: 'actual_filesystem_snapshot'
      }
    ])
  })
})
