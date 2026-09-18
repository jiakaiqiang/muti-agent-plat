import type {
  AgentDefinition as Agent,
  AgentRunResult,
  AgentTask,
  Artifact,
  CollaborationEvent,
  InvocationPlan,
  SessionDetail
} from '@agent-cluster/shared';
import { createAgentMessageOutput, createRuntimeArtifactSystemEvidence } from '@agent-cluster/shared';
import { OrchestratorService } from './orchestrator.service.js';
import { makeInvocationPlan } from '../runtimes/invocation-plan.fixture.js';

/**
 * Shared orchestrator test fixtures. Kept out of any `.spec.ts` file so that a
 * spec importing them does not re-register the whole orchestrator suite.
 */

export function agent(key: string): Agent {
  return {
    id: key,
    key,
    name: `${key} agent`,
    role: key,
    description: `${key} test agent`,
    profileMarkdown: `# ${key}`,
    tags: [],
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    profileRevision: 1,
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z'
  };
}


export type ServiceRecorder = {
  events: CollaborationEvent[];
  createdTasks?: AgentTask[];
  taskUpdates: Array<Partial<AgentTask>>;
  runtimeCalls: number;
  availabilityRefreshes?: number;
};

export function makeService(
  createdArtifacts: Artifact[] = [],
  recorder?: ServiceRecorder,
  fileRevisions?: unknown,
  workspaceProviders?: unknown,
  agentKeys = ['coordinator', 'requirements', 'architect', 'product-manager', 'backend', 'test', 'review'],
  options: { persistence?: unknown; contextManagement?: unknown } = {}
) {
  const agents = new Map(
    agentKeys.map((key) => [
      key,
      agent(key)
    ])
  );
  return new OrchestratorService(
    {
      findByIdOrKey(key: string) {
        return agents.get(key);
      },
      getByIdOrKey(key: string) {
        const found = agents.get(key);
        if (!found) throw new Error(`Unknown agent: ${key}`);
        return found;
      },
      listForSurface() {
        return [...agents.values()];
      },
      findSystemByKey(key: string) {
        return key === 'coordinator' ? agents.get(key) : undefined;
      }
    } as never,
    {
      create(input: Omit<CollaborationEvent, 'id' | 'createdAt' | 'toAgentIds'> & { toAgentIds?: string[] }) {
        const event: CollaborationEvent = {
          id: `event-${(recorder?.events.length ?? 0) + 1}`,
          createdAt: '2026-07-03T00:00:00.000Z',
          toAgentIds: [],
          ...input
        };
        recorder?.events.push(event);
        return event;
      },
      list() {
        return recorder?.events ?? [];
      }
    } as never,
    {
      getAdapter() {
        return undefined;
      },
      findPriorInvocation() {
        return undefined;
      },
      listAvailableRuntimeTypes() {
        return ['mock'];
      },
      async refreshRuntimeAvailability() {
        if (recorder) recorder.availabilityRefreshes = (recorder.availabilityRefreshes ?? 0) + 1;
        return [];
      },
      start(input: InvocationPlan) {
        if (recorder) recorder.runtimeCalls += 1;
        const result: AgentRunResult = {
          invocationId: input.invocationId,
          runtimeType: input.executionTarget.runtimeType,
          status: 'completed',
          output: createAgentMessageOutput({
            messageKind: 'answer',
            content: 'Completed without source evidence.'
          }),
          events: [],
          artifacts: [],
          systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'mock' }
        };
        return {
          events: (async function* () {})(),
          result: Promise.resolve(result),
          async cancel() {},
          hasStreamingEvents: false
        };
      }
    } as never,
    {
      add(task: AgentTask) {
        recorder?.createdTasks?.push(task);
        return task;
      },
      update(task: AgentTask, changes: Partial<AgentTask>) {
        recorder?.taskUpdates.push(changes);
        Object.assign(task, changes);
        return task;
      },
      list() {
        return [];
      }
    } as never,
    {} as never,
    {} as never,
    {
      create(input: Omit<Artifact, 'id' | 'createdAt' | 'dataEpoch' | 'runtimeProposals' | 'platformProjections' | 'systemEvidence'> &
        Partial<Pick<Artifact, 'runtimeProposals' | 'platformProjections' | 'systemEvidence'>>) {
        const artifact: Artifact = {
          id: `artifact-${createdArtifacts.length + 1}`,
          dataEpoch: 'epoch-test',
          createdAt: '2026-07-03T00:00:00.000Z',
          ...input,
          runtimeProposals: input.runtimeProposals ?? [],
          platformProjections: input.platformProjections ?? [],
          systemEvidence: input.systemEvidence ?? null
        };
        createdArtifacts.push(artifact);
        return artifact;
      },
      listBySession() {
        return createdArtifacts;
      },
      get(artifactId: string) {
        const found = createdArtifacts.find((artifact) => artifact.id === artifactId);
        if (!found) throw new Error(`Unknown artifact: ${artifactId}`);
        return found;
      }
    } as never,
    {} as never,
    (options.persistence ?? {
      getCollection<T>(_key: string, fallback: T) {
        return fallback;
      },
      setCollection() {}
    }) as never,
    {} as never,
    {
      workspaceFocus() {
        return undefined;
      }
    } as never,
    {
      compileIdentity({ agent: definition }: { agent: Agent }) {
        return makeInvocationPlan({ agent: { ...definition, agentId: definition.id } }).agent;
      }
    } as never,
    workspaceProviders as never,
    undefined,
    undefined,
    fileRevisions as never,
    undefined,
    undefined,
    options.contextManagement as never
  );
}

export function session(): SessionDetail {
  return {
    id: 'session-1',
    dataEpoch: 'epoch-test',
    title: 'Fix malformed suggested tasks',
    originalInput: 'Fix a backend bug',
    status: 'AGENT_DISCUSSING',
    ownerId: 'user-1',
    workspaceId: 'workspace-1',
    tokenUsed: 0,
    taskDomain: 'coding',
    taskIntent: 'implementation',
    participatingAgentIds: ['coordinator', 'backend', 'test'],
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z'
  };
}
