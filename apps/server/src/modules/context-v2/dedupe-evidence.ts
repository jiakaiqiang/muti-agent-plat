import type { ContextL3EvidenceFile } from '@agent-cluster/shared';

export function dedupeEvidence(files: ContextL3EvidenceFile[]): ContextL3EvidenceFile[] {
  const seenPaths = new Set<string>();
  const seenHashes = new Set<string>();
  const result: ContextL3EvidenceFile[] = [];
  for (const file of files) {
    if (seenPaths.has(file.path)) continue;
    const hashKey = file.hash ? `${file.hash.algorithm}:${file.hash.value}` : null;
    if (hashKey && seenHashes.has(hashKey)) continue;
    seenPaths.add(file.path);
    if (hashKey) seenHashes.add(hashKey);
    result.push(file);
  }
  return result;
}
