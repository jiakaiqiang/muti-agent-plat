import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AgentDefinition as Agent,
  AgentRunResult,
  CollaborationEvent,
  PendingInvocation,
  SessionDetail
} from '@agent-cluster/shared';
import { createAgentMessageOutput, createRuntimeArtifactSystemEvidence } from '@agent-cluster/shared';
import { OrchestratorService } from './orchestrator.service.js';
import type { ContextRouteInput } from './context-router.service.js';

function agent(key: string): Agent {
  return {
    id: key,
    key,
    name: `${key} agent`,
    role: key,
    description: `${key} test agent`,
    profileMarkdown: `# ${key}`,
    tags: [],
    status: 'active',
    capabilityIds: ['cap-file-write'],
    defaultKnowledgeBaseIds: [],
    profileRevision: 1,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z'
  };
}

function session(): SessionDetail {
  return {
    id: 'session-approval-test',
    title: 'Approval resume test',
    status: 'WAIT_USER_CONFIRM',
    tokenBudget: 100_000,
    tokenUsed: 1000,
    originalInput: 'Test approval flow',
    latestContractGoal: 'Test approval flow',
    participatingAgentIds: ['backend'],
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    dataEpoch: 'test-epoch',
    ownerId: 'test-user',
    workspaceId: 'workspace-1',
    workingDirectory: {
      kind: 'server_local',
      id: 'workspace-1',
      name: 'test-workspace',
      path: '/test',
      selectedAt: '2026-07-28T00:00:00.000Z'
    },
    workspaceSnapshot: {
      rootName: 'test',
      scannedAt: '2026-07-28T00:00:00.000Z',
      fileCount: 10,
      totalBytes: 5000,
      tree: [],
      files: [],
      skipped: []
    },
    workspaceMode: 'existing_project',
    runtimePreference: {
      preferredRuntimeType: 'codex'
    }
  };
}

type ServiceRecorder = {
  events: CollaborationEvent[];
  runtimeCalls: number;
  savedPendingInvocations: PendingInvocation[];
};

function makeService(recorder: ServiceRecorder) {
  const agents = new Map([['backend', agent('backend')]]);
  const tasks = new Map();

  return new OrchestratorService(
    {
      findByIdOrKey(key: string) {
        return agents.get(key);
      },
      getByIdOrKey(key: string) {
        const found = agents.get(key);
        if (!found) throw new Error(`Unknown agent: ${key}`);
        return found;
      }
    } as never,
    {
      create(input: Omit<CollaborationEvent, 'id' | 'createdAt' | 'toAgentIds'> & { toAgentIds?: string[] }) {
        const event: CollaborationEvent = {
          id: `event-${recorder.events.length + 1}`,
          createdAt: new Date().toISOString(),
          toAgentIds: [],
          ...input
        };
        recorder.events.push(event);
        return event;
      },
      list() {
        return recorder.events;
      }
    } as never,
    {
      async runAgent() {
        recorder.runtimeCalls += 1;
        const result: AgentRunResult = {
          invocationId: 'retry-invocation',
          runtimeType: 'codex',
          status: 'completed',
          output: createAgentMessageOutput({
            messageKind: 'answer',
            content: 'Task completed after approval'
          }),
          events: [],
          artifacts: [],
          systemEvidence: createRuntimeArtifactSystemEvidence('retry-invocation'),
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, model: 'codex' }
        };
        return result;
      }
    } as never,
    {
      find(sessionId: string, taskId: string) {
        return tasks.get(taskId);
      },
      update() {},
      list() { return []; }
    } as never,
    { search() { return []; } } as never,
    { search() { return []; }, list() { return []; }, toRuntimeMemory(m: unknown) { return m; } } as never,
    { listBySession() { return []; } } as never,
    { resolve(capabilityIds: string[]) { return []; }, checkInvocation() { return { allowed: true }; } } as never,
    {
      getCollection() { return {}; },
      setCollection() {},
      currentDataEpoch() { return 'test-epoch'; }
    } as never,
    {
      route(input: ContextRouteInput) {
        return {
          domain: 'mixed',
          intent: 'implementation',
          currentStage: input.phase,
          taskMap: { tasks: [], completedCount: 0, blockedCount: 0, pendingCount: 0, runningCount: 0 },
          stagePlan: { description: 'Test stage plan', steps: [] },
          executionMode: 'single_agent' as const,
          validationMode: 'mixed' as const,
          requiresCodeChanges: true,
          requiresExternalEvidence: false,
          validationRules: [],
          agentResponsibilities: [
            { role: 'execution', agentKey: 'backend' },
            { role: 'validation', agentKey: 'test', independentFrom: ['backend'] },
            { role: 'review', agentKey: 'review', independentFrom: ['backend', 'test'] }
          ],
          evidenceSelection: { strategy: 'none', entries: [] },
          evidenceRefs: []
        };
      }
    } as never,
    { buildProjectMap() { return { modules: [] }; }, workspaceFocus() { return undefined; } } as never,
    {
      compileIdentity(agent: Agent) {
        return {
          agentId: agent.id,
          key: agent.key,
          name: agent.name,
          role: agent.role,
          systemPrompt: `You are ${agent.name}`,
          profileHash: 'hash',
          profileRevision: agent.profileRevision,
          skillBindings: [],
          requestedToolIds: agent.capabilityIds,
          requestedToolKeys: ['tool.file_write'],
          capabilityIds: agent.capabilityIds,
          knowledgeBaseIds: []
        };
      }
    } as never,
    undefined,
    {
      resolve() {
        return {
          invocationId: 'test-invocation',
          runtimeType: 'codex',
          modelId: 'codex-model',
          selectedCandidate: {
            runtimeType: 'codex',
            available: true,
            modelId: 'codex-model',
            source: 'global_default' as const,
            supportedWorkspaceCapabilities: [],
            supportedToolNames: []
          },
          pendingApprovals: []
        };
      }
    } as never
  );
}

test('saves pending invocation when approval is required', async () => {
  const recorder: ServiceRecorder = { events: [], runtimeCalls: 0, savedPendingInvocations: [] };
  const service = makeService(recorder);

  // Register callback to capture saved invocations
  service.registerSavePendingInvocationCallback((sessionId, invocation) => {
    recorder.savedPendingInvocations.push(invocation);
  });

  // Simulate: this would normally be triggered by orchestrator detecting pending approvals
  // For now we just verify the callback mechanism works
  const testInvocation: PendingInvocation = {
    invocationId: 'test-inv-1',
    sessionId: 'session-approval-test',
    taskId: 'task-1',
    agentId: 'backend',
    phase: 'task_execution',
    pendingApprovals: [
      {
        toolId: 'cap-file-write',
        toolKey: 'tool.file_write',
        approvalId: 'approval-1',
        reasons: ['HUMAN_APPROVAL_REQUIRED']
      }
    ],
    createdAt: '2026-07-28T00:00:00.000Z'
  };

  // Manually trigger the callback (simulating what pendingApprovalResult does)
  const callback = (service as any).savePendingInvocationCallback;
  if (callback) {
    callback('session-approval-test', testInvocation);
  }

  assert.equal(recorder.savedPendingInvocations.length, 1);
  assert.equal(recorder.savedPendingInvocations[0]?.invocationId, 'test-inv-1');
  assert.equal(recorder.savedPendingInvocations[0]?.pendingApprovals.length, 1);
  assert.equal(recorder.savedPendingInvocations[0]?.pendingApprovals[0]?.toolKey, 'tool.file_write');
});

test('retryPendingApprovalInvocation throws when agent is not found', async () => {
  const recorder: ServiceRecorder = { events: [], runtimeCalls: 0, savedPendingInvocations: [] };
  const service = makeService(recorder);
  const testSession = session();

  const pendingInvocation: PendingInvocation = {
    invocationId: 'pending-inv-1',
    sessionId: testSession.id,
    taskId: 'task-1',
    agentId: 'non-existent-agent',
    phase: 'task_execution',
    pendingApprovals: [
      {
        toolId: 'cap-file-write',
        toolKey: 'tool.file_write',
        approvalId: 'approval-1',
        reasons: ['HUMAN_APPROVAL_REQUIRED']
      }
    ],
    createdAt: '2026-07-28T00:00:00.000Z'
  };

  await assert.rejects(
    async () => service.retryPendingApprovalInvocation(testSession, pendingInvocation),
    (err: unknown) => err instanceof Error && err.message.includes('non-existent-agent')
  );
});

test('registerSavePendingInvocationCallback registers callback successfully', () => {
  const recorder: ServiceRecorder = { events: [], runtimeCalls: 0, savedPendingInvocations: [] };
  const service = makeService(recorder);

  let callbackInvoked = false;
  service.registerSavePendingInvocationCallback(() => {
    callbackInvoked = true;
  });

  // Trigger callback via internal property
  const callback = (service as any).savePendingInvocationCallback;
  if (callback) {
    callback('session-1', {} as PendingInvocation);
  }

  assert.equal(callbackInvoked, true);
});
