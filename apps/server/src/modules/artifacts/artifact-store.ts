import { isDeepStrictEqual } from 'node:util';
import type { Artifact, SessionDetail } from '@agent-cluster/shared';
import type { PersistedState } from '../persistence/persistence.service.js';
import type { SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';

export type ArtifactState = { artifactsById: Record<string, Artifact>; artifactIdsBySession: Record<string, string[]> };

/** Shared transaction primitive. Callers must include artifacts, sessions and session lifecycles in their transaction. */
export function appendArtifactInDraft(draft: PersistedState, artifact: Artifact): Artifact {
  const session = (draft.sessions as SessionDetail[] | undefined)?.find(row => row.id === artifact.sessionId);
  const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[artifact.sessionId];
  if (!session || session.archivedAt || session.status === 'CANCELLED' || session.dataEpoch !== artifact.dataEpoch ||
    (lifecycle && (lifecycle.state !== 'active' || lifecycle.dataEpoch !== artifact.dataEpoch))) throw new Error('ARTIFACT_SESSION_UNAVAILABLE');
  const state = (draft.artifacts ??= { artifactsById: {}, artifactIdsBySession: {} }) as ArtifactState;
  const existing = state.artifactsById[artifact.id];
  if (existing && !isDeepStrictEqual(existing, artifact)) throw new Error('ARTIFACT_IDENTITY_CONFLICT');
  state.artifactsById[artifact.id] = structuredClone(artifact);
  const ids = state.artifactIdsBySession[artifact.sessionId] ??= [];
  if (!ids.includes(artifact.id)) ids.push(artifact.id);
  return structuredClone(artifact);
}
