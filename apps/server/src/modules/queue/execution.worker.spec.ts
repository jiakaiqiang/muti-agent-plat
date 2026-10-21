import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionWorker } from './execution.worker.js';
import { approvedResumeState } from '../message-routing/intent-resume.fixture.js';
import { bindIntentResume } from '../message-routing/intent-resume-guard.js';
import { approvedRetryState } from '../message-routing/intent-retry.fixture.js';

test('R8 queued retry rechecks authority and selects one task without resetting unfinished tasks', async () => {
  for (const invalidated of [false, true]) {
    const state: any = approvedRetryState(), session = state.sessions[0], task = state.tasksBySession.session[0];
    const binding = session.activeRecoveryCheckpoint.retryBinding;
    state.intentPlanStepsBySession.session[0].retryReceipts = [{ status: 'applied', binding, processId: 'dispatch' }];
    session.status = 'EXECUTING'; task.status = invalidated ? 'cancelled' : 'pending';
    const others = [{ id: 'other', status: 'running' }, { id: 'upstream', status: 'completed' }], before = structuredClone(others);
    const calls: any[][] = [];
    const worker = new ExecutionWorker({ getBrief: () => state.briefsBySession.session[0],
      runPipeline: async (...args: any[]) => { calls.push(args); return { kind: 'retry_task_completed' }; } } as never,
      { matchesActiveGeneration: () => true, get: () => session, applyQueuedExecutionOutcome: async () => {} } as never,
      { list: () => [task, ...others], resetStaleRunning: () => { throw new Error('retry must not reset all tasks'); },
        unfinished: () => { throw new Error('retry must not collect all unfinished tasks'); } } as never,
      { registerAbortController: () => new AbortController(), releaseAbortController: () => {} } as never,
      { currentDataEpoch: () => 'epoch', getCollection: (key: string, fallback: unknown) => structuredClone(state[key] ?? fallback) } as never);
    const invoke = () => (worker as any).processJob({ id: 'job', data: { sessionId: 'session', briefId: 'approved-brief',
      dataEpoch: 'epoch', sessionGeneration: 1, intentRetryBinding: binding } });
    if (invalidated) { await assert.rejects(invoke(), /INTENT_RETRY_TARGET_OBSOLETE/); assert.equal(calls.length, 0); }
    else { await invoke(); assert.equal(calls.length, 1); assert.deepEqual(calls[0][2], [task]); assert.deepEqual(calls[0][4], binding); }
    assert.deepEqual(others, before);
  }
});

test('R7 queued resume rechecks authority and dispatches only bound tasks without resetting other WorkItems', async () => {
  for (const invalidated of [false, true]) {
    const state: any = approvedResumeState(), session = state.sessions[0];
    const binding = bindIntentResume(state, 'session', 'user'); session.status = 'EXECUTING';
    const bound = state.tasksBySession.session[0]; bound.status = 'running';
    const tasks = [bound, { id: 'other', workItemId: 'another', status: 'running' }, { id: 'unbound', status: 'running' }];
    const calls: any[][] = [], resets: string[] = [];
    if (invalidated) bound.status = 'cancelled';
    const worker = new ExecutionWorker({ getBrief: () => state.briefsBySession.session[0],
      runPipeline: async (...args: any[]) => { calls.push(args); return { kind: 'completed' }; } } as never,
      { matchesActiveGeneration: () => true, get: () => session, applyQueuedExecutionOutcome: async () => {} } as never,
      { list: () => tasks, update: (task: any, patch: any) => { resets.push(task.id); Object.assign(task, patch); },
        resetStaleRunning: () => { for (const task of tasks) { resets.push(task.id); task.status = 'pending'; } }, unfinished: () => tasks } as never,
      { registerAbortController: () => new AbortController(), releaseAbortController: () => {} } as never,
      { currentDataEpoch: () => 'epoch', getCollection: (key: string, fallback: unknown) => structuredClone(state[key] ?? fallback) } as never);
    const invoke = () => (worker as any).processJob({ id: 'job', data: { sessionId: 'session', briefId: 'approved-brief',
      dataEpoch: 'epoch', sessionGeneration: 1, intentResumeBinding: binding } });
    if (invalidated) { await assert.rejects(invoke(), /INTENT_RESUME_TARGET_OBSOLETE/); assert.equal(calls.length, 0); assert.deepEqual(resets, []); }
    else {
      await invoke(); assert.equal(calls.length, 1); assert.deepEqual(calls[0][2].map((task: any) => task.id), ['original-task']);
      assert.deepEqual(resets, ['original-task']); assert.equal(tasks[1].status, 'running'); assert.equal(tasks[2].status, 'running');
    }
  }
});
