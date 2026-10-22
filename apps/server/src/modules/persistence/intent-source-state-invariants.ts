import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Row = Record<string, any>;
const authorityBody = (row: Row) => {
  const { authorityHash: _hash, revokedAt: _revoked, revokedBy: _by, applyClaims: _claims, ...body } = row; return body;
};
const snapshotBody = (row: Row) => {
  const { candidate: _candidate, proposalHash: _proposal, ...body } = row; return body;
};

/** Protect Session JSON fields equally on File and relational projections. */
export function assertIntentSourceStateMutation(before: Record<string, unknown>, after: Record<string, unknown>) {
  for (const session of (after.sessions ?? []) as Row[]) {
    const previous = ((before.sessions ?? []) as Row[]).find(row => row.id === session.id);
    const authorities: Row[] = session.intentSourceAuthorities ?? [], oldAuthorities: Row[] = previous?.intentSourceAuthorities ?? [];
    if (!Array.isArray(authorities) || authorities.length < oldAuthorities.length) throw new Error('INTENT_SOURCE_AUTHORITY_IMMUTABLE');
    const identities = new Set<string>();
    for (let i = 0; i < authorities.length; i++) {
      const row = authorities[i], old = oldAuthorities[i];
      if (!row || row.sessionId !== session.id || typeof row.id !== 'string' || identities.has(row.id) ||
        !Number.isSafeInteger(row.revision) || row.revision < 1 || !Array.isArray(row.files) || !row.files.length ||
        !Array.isArray(row.prohibitions) || !Array.isArray(row.applyClaims) || row.authorityHash !== hash(authorityBody(row)) ||
        (old && (!isDeepStrictEqual(authorityBody(old), authorityBody(row)) ||
          (old.revokedAt && (row.revokedAt !== old.revokedAt || row.revokedBy !== old.revokedBy))))) throw new Error('INTENT_SOURCE_AUTHORITY_IMMUTABLE');
      identities.add(row.id);
      const claims: Row[] = row.applyClaims, previousClaims: Row[] = old?.applyClaims ?? [];
      if (claims.length < previousClaims.length) throw new Error('INTENT_SOURCE_AUTHORITY_IMMUTABLE');
      const claimIds = new Set<string>();
      for (let j = 0; j < claims.length; j++) {
        const claim = claims[j], previousClaim = previousClaims[j];
        const body = (value: Row) => { const { outcome: _outcome, finishedAt: _finished, ...rest } = value; return rest; };
        if (claim.authorityId !== row.id || claim.sessionId !== session.id || !claim.id || claimIds.has(claim.id) ||
          (claim.outcome && !['applied', 'not_applied', 'unknown'].includes(claim.outcome)) ||
          (previousClaim && (!isDeepStrictEqual(body(previousClaim), body(claim)) ||
            (previousClaim.outcome && !isDeepStrictEqual(previousClaim, claim))))) throw new Error('INTENT_SOURCE_AUTHORITY_IMMUTABLE');
        claimIds.add(claim.id);
      }
    }
    const snapshots: Row[] = session.intentSourceCandidates ?? [], oldSnapshots: Row[] = previous?.intentSourceCandidates ?? [];
    if (!Array.isArray(snapshots) || snapshots.length < oldSnapshots.length) throw new Error('INTENT_SOURCE_CANDIDATE_IMMUTABLE');
    const invocations = new Set<string>();
    for (let i = 0; i < snapshots.length; i++) {
      const row = snapshots[i], old = oldSnapshots[i];
      if (!row || row.binding?.sessionId !== session.id || !row.id || !Array.isArray(row.files) || !row.files.length ||
        invocations.has(row.binding.invocationId) || row.snapshotHash !== hash({ binding: row.binding, files: row.files, baseRevision: row.baseRevision }) ||
        (old && (!isDeepStrictEqual(snapshotBody(old), snapshotBody(row)) ||
          (old.candidate && (!isDeepStrictEqual(old.candidate, row.candidate) || old.proposalHash !== row.proposalHash))))) throw new Error('INTENT_SOURCE_CANDIDATE_IMMUTABLE');
      invocations.add(row.binding.invocationId);
      if (Boolean(row.candidate) !== Boolean(row.proposalHash)) throw new Error('INTENT_SOURCE_CANDIDATE_IMMUTABLE');
      if (row.candidate && (row.candidate.sessionId !== session.id || row.candidate.invocationId !== row.binding.invocationId ||
        row.candidate.taskId !== row.binding.taskId || row.candidate.workItemId !== row.binding.workItemId)) throw new Error('INTENT_SOURCE_CANDIDATE_IMMUTABLE');
    }
  }
}
