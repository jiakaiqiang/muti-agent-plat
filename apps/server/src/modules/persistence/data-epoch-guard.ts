import type { SessionDetail } from '@agent-cluster/shared';

export function assertCurrentDataEpoch(currentEpoch: string, candidateEpoch: string, subject: string): void {
  if (candidateEpoch !== currentEpoch) {
    throw new Error(
      `STALE_DATA_EPOCH: ${subject} belongs to ${candidateEpoch || 'missing'}, current epoch is ${currentEpoch}.`
    );
  }
}

export function filterSessionsForDataEpoch(sessions: SessionDetail[], currentEpoch: string): SessionDetail[] {
  return sessions.filter((session) => session.dataEpoch === currentEpoch);
}
