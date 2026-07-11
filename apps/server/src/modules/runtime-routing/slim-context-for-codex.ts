import type { ContextEnvelopeV2 } from '@agent-cluster/shared';

export interface CodexSlimContext {
  workspaceId: string;
  sessionId: string;
  identity: ContextEnvelopeV2['L0'];
  navigation: {
    path: string;
    kind: 'file' | 'directory';
  }[];
  navigationTruncated: boolean;
  rulesSummary: string[];
}

export function slimContextForCodex(envelope: ContextEnvelopeV2, rulesSummary: string[] = []): CodexSlimContext {
  return {
    workspaceId: envelope.workspaceId,
    sessionId: envelope.sessionId,
    identity: envelope.L0,
    navigation: envelope.L1.entries.map((entry) => ({ path: entry.path, kind: entry.kind })),
    navigationTruncated: envelope.L1.truncated,
    rulesSummary
  };
}
