import type { ContextEnvelopeV2 } from '@agent-cluster/shared';

export interface ClaudeSlimContext {
  version: 'v2';
  workspaceId: string;
  sessionId: string;
  identity: ContextEnvelopeV2['L0'];
  navigation: { path: string; kind: 'file' | 'directory'; language?: string }[];
  navigationTruncated: boolean;
  projectMap: {
    source: ContextEnvelopeV2['L2']['source'];
    modules: {
      name: string;
      path: string;
      responsibility: string;
      entrypoints?: string[];
      tests?: string[];
    }[];
  };
  evidenceSummary: {
    fileCount: number;
    totalByteLength: number;
    truncated: boolean;
    paths: string[];
  };
  rulesSummary: string[];
}

export function slimContextForClaude(
  envelope: ContextEnvelopeV2,
  rulesSummary: string[] = []
): ClaudeSlimContext {
  return {
    version: 'v2',
    workspaceId: envelope.workspaceId,
    sessionId: envelope.sessionId,
    identity: envelope.L0,
    navigation: envelope.L1.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      ...(entry.kind === 'file' && entry.language ? { language: entry.language } : {})
    })),
    navigationTruncated: envelope.L1.truncated,
    projectMap: {
      source: envelope.L2.source,
      modules: envelope.L2.modules.map((module) => ({
        name: module.name,
        path: module.path,
        responsibility: module.responsibility,
        ...(module.entrypoints && module.entrypoints.length > 0 ? { entrypoints: module.entrypoints } : {}),
        ...(module.tests && module.tests.length > 0 ? { tests: module.tests } : {})
      }))
    },
    evidenceSummary: {
      fileCount: envelope.L3.files.length,
      totalByteLength: envelope.L3.totalByteLength,
      truncated: envelope.L3.truncated,
      paths: envelope.L3.files.map((file) => file.path)
    },
    rulesSummary
  };
}
