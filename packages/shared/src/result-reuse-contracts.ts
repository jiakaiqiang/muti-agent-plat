/**
 * Evidence that a completed result still answers the requirement it is about to
 * be credited to (P5-AC4).
 *
 * After a scope change the user may choose to revise instead of restarting, and
 * work already finished is expensive to throw away. Reusing it is only honest
 * when every version the work was produced against still holds: the requirement
 * revision, the confirmed document version and its content, the inputs the
 * invocation actually read, and the files it claimed to have produced. A result
 * that carries no evidence is never reusable — absence of proof is not proof.
 *
 * Browser-safe on purpose: this module is consumed by web and desktop as well as
 * the server, so it must not import `node:*`.
 */

export const RESULT_REUSE_CONTRACT_VERSION = 'result-reuse-v1' as const;

export type ResultReuseEvidence = {
  workItemId: string;
  /** Requirement revision the result was produced against. */
  workItemRevision: number;
  /** Confirmed document revision at the time of production; 0 when none was published. */
  documentRevision: number;
  /** Digest of the confirmed document body; a rewrite under the same revision still invalidates reuse. */
  contentHash: string;
  /** Digest of the inputs the invocation actually read. */
  inputFingerprint: string;
  /** Files the result claimed, by path, with the hash observed when it completed. */
  fileHashes: Record<string, string>;
};

export type ResultReuseRejection =
  | 'evidence_missing'
  | 'work_item_changed'
  | 'work_item_revision_changed'
  | 'document_revision_changed'
  | 'content_hash_changed'
  | 'input_fingerprint_changed'
  | 'file_hash_changed';

export type ResultReuseOutcome =
  | { reusable: true }
  | { reusable: false; reason: ResultReuseRejection; changedFilePaths?: string[] };

/**
 * Normalises the versions a result was produced against into the stored record.
 * Deterministic by construction: the same inputs always produce the same
 * evidence, so a replayed check cannot disagree with the first one.
 */
export function resultReuseEvidence(input: ResultReuseEvidence): ResultReuseEvidence {
  return {
    workItemId: input.workItemId,
    workItemRevision: Math.max(0, Math.floor(input.workItemRevision)),
    documentRevision: Math.max(0, Math.floor(input.documentRevision)),
    contentHash: input.contentHash,
    inputFingerprint: input.inputFingerprint,
    // Sorted so two instances recording the same files produce byte-identical
    // evidence; a Record iterates in insertion order otherwise.
    fileHashes: Object.fromEntries(
      Object.keys(input.fileHashes).sort().map((path) => [path, input.fileHashes[path]!])
    )
  };
}

/**
 * Whether completed work may be credited to the current requirement. The checks
 * run coarse to fine so the reported reason names the outermost thing that
 * changed, which is what the coordinator has to explain to the user.
 */
export function canReuseCompletedResult(
  evidence: ResultReuseEvidence | undefined,
  current: ResultReuseEvidence
): ResultReuseOutcome {
  if (!evidence) return { reusable: false, reason: 'evidence_missing' };
  if (evidence.workItemId !== current.workItemId) {
    return { reusable: false, reason: 'work_item_changed' };
  }
  if (evidence.workItemRevision !== current.workItemRevision) {
    return { reusable: false, reason: 'work_item_revision_changed' };
  }
  if (evidence.documentRevision !== current.documentRevision) {
    return { reusable: false, reason: 'document_revision_changed' };
  }
  if (evidence.contentHash !== current.contentHash) {
    return { reusable: false, reason: 'content_hash_changed' };
  }
  if (evidence.inputFingerprint !== current.inputFingerprint) {
    return { reusable: false, reason: 'input_fingerprint_changed' };
  }
  // Only the files the result claimed are its own business; an unrelated edit
  // elsewhere in the tree does not invalidate work that never touched it.
  const changedFilePaths = Object.keys(evidence.fileHashes)
    .filter((path) => current.fileHashes[path] !== evidence.fileHashes[path])
    .sort();
  if (changedFilePaths.length) {
    return { reusable: false, reason: 'file_hash_changed', changedFilePaths };
  }
  return { reusable: true };
}

/**
 * A result that landed after the requirement moved on. The invocation was
 * dispatched against an older (or, if the caller itself is stale, a different)
 * revision, so accepting it would credit the current requirement with work done
 * against another one.
 */
export function isLateResultForSupersededRevision(
  evidence: ResultReuseEvidence,
  current: { workItemRevision: number; documentRevision: number }
): boolean {
  return (
    evidence.workItemRevision !== current.workItemRevision ||
    evidence.documentRevision !== current.documentRevision
  );
}
