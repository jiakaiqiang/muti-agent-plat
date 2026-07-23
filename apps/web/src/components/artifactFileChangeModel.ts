import type { ArtifactEventPayload, RuntimeFileChange } from '@/types/contracts'

export function observedArtifactFileChanges(payload?: ArtifactEventPayload): RuntimeFileChange[] {
  return (payload?.systemEvidence?.workspaceChangeSet?.changes ?? []).flatMap<RuntimeFileChange>((change) => {
    if (change.operation === 'move') return []
    if (change.operation === 'delete') {
      return [{
        path: change.path,
        operation: 'delete' as const,
        source: 'actual_filesystem_snapshot' as const
      }]
    }
    return [{
      path: change.path,
      operation: change.operation,
      content: change.content,
      encoding: change.encoding,
      source: 'actual_filesystem_snapshot' as const
    }]
  })
}

export function platformArtifactProjections(payload?: ArtifactEventPayload): RuntimeFileChange[] {
  return payload?.platformProjections ?? []
}

export function applicableArtifactFileChanges(payload?: ArtifactEventPayload): RuntimeFileChange[] {
  const byPath = new Map<string, RuntimeFileChange>()
  for (const change of platformArtifactProjections(payload)) {
    byPath.set(change.path, change)
  }
  for (const change of observedArtifactFileChanges(payload)) {
    byPath.set(change.path, change)
  }
  return [...byPath.values()]
}
