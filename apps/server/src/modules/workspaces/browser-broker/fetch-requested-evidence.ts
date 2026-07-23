import type { ContextL3EvidenceFile, ReadFileResult } from '@agent-cluster/shared';

export interface EvidenceFetchProvider {
  readFile: (input: { path: string }) => Promise<ReadFileResult>;
}

export interface FetchRequestedEvidenceArgs {
  provider: EvidenceFetchProvider;
  requestedPaths: string[];
}

export interface FetchRequestedEvidenceResult {
  files: ContextL3EvidenceFile[];
  errors: { path: string; message: string }[];
}

export async function fetchRequestedEvidence(
  args: FetchRequestedEvidenceArgs
): Promise<FetchRequestedEvidenceResult> {
  const files: ContextL3EvidenceFile[] = [];
  const errors: { path: string; message: string }[] = [];
  for (const path of args.requestedPaths) {
    try {
      const result = await args.provider.readFile({ path });
      files.push({
        path: result.path,
        content: result.content,
        byteLength: result.byteLength,
        hash: result.hash,
        ...(result.startLine !== undefined ? { startLine: result.startLine } : {}),
        ...(result.endLine !== undefined ? { endLine: result.endLine } : {})
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ path, message });
    }
  }
  return { files, errors };
}
