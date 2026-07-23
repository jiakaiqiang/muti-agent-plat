import type {
  RuntimeArtifactOutput,
  RuntimeArtifactProposalMetadata
} from './artifact-contracts.js';
import type { RuntimeArtifactSystemEvidence } from '../contracts.js';
import type { AgentMessageOutput } from './output-contracts.js';

export function emptyRuntimeArtifactProposalMetadata(): RuntimeArtifactProposalMetadata {
  return {
    fileChanges: [],
    validationEvidence: null,
    summaryMemoryCheckpoint: null
  };
}

export function createRuntimeArtifactOutput(
  input: Pick<RuntimeArtifactOutput, 'type' | 'title' | 'content'> &
    Partial<Pick<RuntimeArtifactOutput, 'uri' | 'summary' | 'metadata'>>
): RuntimeArtifactOutput {
  return {
    type: input.type,
    title: input.title,
    content: input.content,
    uri: input.uri ?? null,
    summary: input.summary ?? null,
    metadata: input.metadata ?? emptyRuntimeArtifactProposalMetadata()
  };
}

export function createRuntimeArtifactSystemEvidence(
  invocationId: string,
  input: Partial<Pick<RuntimeArtifactSystemEvidence, 'workspaceChangeSet' | 'verifiedTestResults' | 'capturedAt'>> = {}
): RuntimeArtifactSystemEvidence {
  return {
    workspaceChangeSet: input.workspaceChangeSet ?? null,
    verifiedTestResults: input.verifiedTestResults ?? [],
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    invocationId
  };
}

export function createAgentMessageOutput(
  input: Pick<AgentMessageOutput, 'messageKind' | 'content'> &
    Partial<
      Pick<
        AgentMessageOutput,
        'targetAgentIds' | 'targetAgentKeys' | 'mentionedAgentIds' | 'relatedTaskIds'
      >
    >
): AgentMessageOutput {
  return {
    schemaVersion: '1.0',
    kind: 'agent_message',
    messageKind: input.messageKind,
    content: input.content,
    targetAgentIds: input.targetAgentIds ?? [],
    targetAgentKeys: input.targetAgentKeys ?? [],
    mentionedAgentIds: input.mentionedAgentIds ?? [],
    relatedTaskIds: input.relatedTaskIds ?? []
  };
}
