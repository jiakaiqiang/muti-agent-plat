import type { EvidenceSourceType, RuntimeContextRequest, TaskEvidenceRef } from '@agent-cluster/shared';

const EVIDENCE_TYPES = new Set<EvidenceSourceType>([
  'project_map',
  'workspace_snapshot',
  'workspace_file',
  'workspace_symbol',
  'log',
  'test',
  'diff',
  'event_log',
  'memory',
  'artifact',
  'user_input',
  'external_reference',
  'document_fragment',
  'meeting_note',
  'data_table',
  'historical_decision'
]);

const MAX_REFS = 32;
const MAX_PATHS = 32;
const MAX_COMMANDS = 8;
const WORKSPACE_REF_TYPES = new Set<EvidenceSourceType>(['workspace_file', 'workspace_symbol', 'test']);

export function normalizeRuntimeContextRequest(value: unknown): RuntimeContextRequest | undefined {
  if (!isRecord(value)) return undefined;
  const reason = plainText(value.reason);
  if (!reason) return undefined;

  const refs: TaskEvidenceRef[] = [];
  const paths: string[] = [];
  if (value.requestedRefs !== undefined) {
    if (!Array.isArray(value.requestedRefs)) return undefined;
    for (const candidate of value.requestedRefs) {
      if (typeof candidate === 'string') {
        const path = candidate.trim();
        if (path) paths.push(path);
        continue;
      }
      const ref = normalizeEvidenceRef(candidate);
      if (!ref) return undefined;
      refs.push(ref);
      if (WORKSPACE_REF_TYPES.has(ref.type) && ref.ref) paths.push(ref.ref);
    }
  }

  const requestedPaths = stringList(value.requestedPaths);
  const requestedCommands = stringList(value.requestedCommands);
  if (requestedPaths === undefined || requestedCommands === undefined) return undefined;
  paths.push(...requestedPaths);

  return {
    reason,
    requestedRefs: uniqueRefs(refs).slice(0, MAX_REFS),
    ...(paths.length ? { requestedPaths: uniqueStrings(paths).slice(0, MAX_PATHS) } : {}),
    ...(requestedCommands.length
      ? { requestedCommands: uniqueStrings(requestedCommands).slice(0, MAX_COMMANDS) }
      : {}),
    ...(plainText(value.followUpInstruction)
      ? { followUpInstruction: plainText(value.followUpInstruction) }
      : {})
  };
}

function normalizeEvidenceRef(value: unknown): TaskEvidenceRef | undefined {
  if (!isRecord(value)) return undefined;
  const type = plainText(value.type) as EvidenceSourceType;
  const label = plainText(value.label);
  if (!EVIDENCE_TYPES.has(type) || !label) return undefined;
  const ref = plainText(value.ref);
  if (WORKSPACE_REF_TYPES.has(type) && !ref) return undefined;
  return { type, label, ...(ref ? { ref } : {}) };
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined;
  return value.map((item) => item.trim()).filter(Boolean);
}

function uniqueRefs(refs: TaskEvidenceRef[]) {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.type}:${ref.ref ?? ref.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values));
}

function plainText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
