import type { SessionDetail, WorkItem } from '@agent-cluster/shared';
import type { PersistedState } from '../persistence/persistence.service.js';
import { approvedResumeState, seedApprovedResume } from './intent-resume.fixture.js';
import { bindIntentResume } from './intent-resume-guard.js';

/** Historical failure proof for tests; production must capture this at failure time. */
export function seedFailedRetry(state: PersistedState, session: SessionDetail, work: WorkItem) {
  seedApprovedResume(state, session, work);
  const { pauseRevision: _revision, pausedAt: _pausedAt, tasks, ...authority } = bindIntentResume(state, session.id, session.ownerId);
  const task = (state.tasksBySession as any)[session.id].find((row: any) => row.id === 'original-task');
  Object.assign(task, { status: 'failed', dependsOnTaskIds: [], title: 'failed read', updatedAt: new Date().toISOString() });
  const operation = (state.logicalOperationsBySession as any)[session.id].find((row: any) => row.id === 'original-operation');
  Object.assign(operation, { status: 'ready', invocationIds: ['failed-call'], activeInvocationId: undefined });
  session.status = 'FAILED'; work.status = 'FAILED';
  const binding = { ...authority, actorId: session.ownerId, checkpointId: 'failed-checkpoint', task: tasks[0],
    failure: { invocationId: 'failed-call', phase: 'task_execution', runtimeType: 'generic_llm', attempt: 1 } };
  session.activeRecoveryCheckpoint = { confirmationId: binding.checkpointId, reason: 'retry_failed_execution',
    retryable: true, createdAt: new Date().toISOString(), retryBinding: binding } as any;
  state.runtimeInvocationsBySession = { [session.id]: [{ id: 'failed-call', invocationId: 'failed-call', sessionId: session.id,
    dataEpoch: session.dataEpoch, contextGeneration: 1, taskId: task.id, workItemId: work.id, phase: 'task_execution',
    runtimeType: 'generic_llm', status: 'failed', executionBinding: tasks[0].executionBinding,
    operation: structuredClone(operation), executionTarget: { runtimeType: 'generic_llm', writeMode: 'none', executionLocation: 'server' },
    error: { code: 'MODEL_ERROR', message: 'connection failed', retryable: false } }] };
  return binding;
}

export function approvedRetryState(): PersistedState {
  const state = approvedResumeState();
  for (const key of ['tasksBySession', 'briefsBySession', 'intentRoutingRecordsBySession', 'intentRouteRevisionsBySession', 'intentPlanStepsBySession', 'logicalOperationsBySession']) delete state[key];
  seedFailedRetry(state, (state.sessions as SessionDetail[])[0], (state.workItemsBySession as Record<string, WorkItem[]>).session[0]);
  return state;
}
