import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionTermination } from '@agent-cluster/shared';
import { createExecutionTermination } from '../../common/execution-termination.js';
import { ExecutionService } from './execution.service.js';
import { IntentExecutionSupersededError } from '../message-routing/intent-execution-guard.js';
import { approvedResumeState } from '../message-routing/intent-resume.fixture.js';
import { bindIntentResume } from '../message-routing/intent-resume-guard.js';
import { approvedRetryState } from '../message-routing/intent-retry.fixture.js';

test('R8 local retry dispatch carries its binding and rejects authority changes before the pipeline', async () => {
  for (const invalidated of [false, true]) {
    const state: any = approvedRetryState(), session = state.sessions[0], task = state.tasksBySession.session[0];
    const binding = session.activeRecoveryCheckpoint.retryBinding;
    state.intentPlanStepsBySession.session[0].retryReceipts = [{ status: 'running', processId: 'dispatch', binding }];
    session.status = 'EXECUTING'; task.status = invalidated ? 'cancelled' : 'pending';
    const calls: any[][] = [];
    const service = new ExecutionService({ runPipeline: async (...args: any[]) => { calls.push(args); return { kind: 'retry_task_completed' }; } } as never,
      {} as never, { getCollection: (key: string, fallback: unknown) => structuredClone(state[key] ?? fallback) } as never);
    const invoke = () => service.start(session, state.briefsBySession.session[0], [task], () => {}, 1, undefined, binding);
    if (invalidated) { assert.throws(invoke, /INTENT_RETRY_TARGET_OBSOLETE/); assert.equal(calls.length, 0); }
    else { invoke(); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 1); assert.deepEqual(calls[0][4], binding); }
  }
});

test('R7 execution rechecks resume authority before invoking the pipeline or queue', () => {
  const state: any = approvedResumeState(), binding = bindIntentResume(state, 'session', 'user');
  state.tasksBySession.session[0].status = 'cancelled';
  let calls = 0;
  const service = new ExecutionService({ runPipeline() { calls++; } } as never, { enqueue() { calls++; } } as never,
    { getCollection: (key: string, fallback: unknown) => structuredClone(state[key] ?? fallback) } as never);
  assert.throws(() => service.start(state.sessions[0], state.briefsBySession.session[0], [], () => {}, 1, binding), /INTENT_RESUME_TARGET_OBSOLETE/);
  assert.equal(calls, 0);
});

test('an audited superseded result releases the pipeline without invoking an outcome or scheduling a retry', async () => {
  let calls = 0, outcomes = 0;
  const service = new ExecutionService({ async runPipeline() {
    calls += 1; throw new IntentExecutionSupersededError('INTENT_DISPATCH_HELD');
  } } as never, {} as never);
  service.start({ id: 'superseded' } as never, {} as never, [], () => { outcomes += 1; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(outcomes, 0);
  assert.equal(service.isRunning('superseded'), false);
});

test('graceful shutdown aborts active execution with service_shutdown and rejects new work', async () => {
  let observedTermination: ExecutionTermination | undefined;
  let runCount = 0;
  const orchestrator = {
    async runPipeline(_session: unknown, _brief: unknown, _tasks: unknown, signal: AbortSignal) {
      runCount += 1;
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      observedTermination = signal.reason as ExecutionTermination;
      return { kind: 'cancelled', reason: 'interrupted' };
    }
  };
  const queue = { cancel() {}, cancelAll() {} };
  const service = new ExecutionService(orchestrator as never, queue as never);
  const outcomes: string[] = [];
  const outcomeTerminations: Array<ExecutionTermination | undefined> = [];
  const session = { id: 'session-1', dataEpoch: 'epoch-1' };
  const brief = { id: 'brief-1' };

  service.start(session as never, brief as never, [], (outcome) => {
    outcomes.push(outcome.kind);
    outcomeTerminations.push(outcome.kind === 'cancelled' ? outcome.termination : undefined);
  });
  await service.beforeApplicationShutdown('SIGTERM');

  assert.equal(observedTermination?.kind, 'service_shutdown');
  assert.equal(observedTermination?.graceful, true);
  assert.deepEqual(outcomes, ['cancelled']);

  service.start(session as never, brief as never, [], (outcome) => {
    outcomes.push(outcome.kind);
    outcomeTerminations.push(outcome.kind === 'cancelled' ? outcome.termination : undefined);
  });
  assert.equal(runCount, 1);
  assert.deepEqual(outcomes, ['cancelled', 'cancelled']);
  assert.equal(outcomeTerminations[1]?.kind, 'service_shutdown');
  assert.equal(outcomeTerminations[1]?.scope, 'service');
});

test('pipeline rejection preserves structured RuntimeError in the failed outcome', async () => {
  const runtimeError = {
    code: 'RUNTIME_OUTPUT_CONTRACT_VIOLATION' as const,
    message: 'kind schema mismatch',
    retryable: false,
    details: { contractId: 'runtime.output.task_brief' }
  };
  const orchestrator = {
    async runPipeline() {
      throw Object.assign(new Error('Codex output rejected'), { cause: runtimeError });
    }
  };
  const service = new ExecutionService(orchestrator as never, { cancel() {}, cancelAll() {} } as never);

  const outcome = await new Promise<Parameters<Parameters<ExecutionService['start']>[3]>[0]>((resolve) => {
    service.start({ id: 'session-error', dataEpoch: 'epoch-1' } as never, { id: 'brief-error' } as never, [], resolve);
  });

  assert.equal(outcome.kind, 'failed');
  if (outcome.kind !== 'failed') return;
  assert.deepEqual(outcome.error, runtimeError);
});

test('admission closure after a structured stop is cancelled without crash logging', async () => {
  const orchestrator = {
    async runPipeline(_session: unknown, _brief: unknown, _tasks: unknown, signal: AbortSignal) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('SESSION_ADMISSION_CLOSED');
    }
  };
  const service = new ExecutionService(orchestrator as never, { cancel() {}, cancelAll() {} } as never);
  const errorLogs: unknown[][] = [];
  (service as unknown as { logger: { error: (...args: unknown[]) => void } }).logger.error = (...args) => {
    errorLogs.push(args);
  };

  const outcomePromise = new Promise<Parameters<Parameters<ExecutionService['start']>[3]>[0]>((resolve) => {
    service.start({ id: 'session-paused', dataEpoch: 'epoch-1' } as never, { id: 'brief-paused' } as never, [], resolve);
  });
  const termination = createExecutionTermination({
    kind: 'user_paused',
    source: 'user',
    scope: 'session'
  });
  service.cancel('session-paused', termination);

  const outcome = await outcomePromise;
  assert.equal(outcome.kind, 'cancelled');
  if (outcome.kind !== 'cancelled') return;
  assert.equal(outcome.reason, 'Session admission closed.');
  assert.equal(outcome.termination?.terminationId, termination.terminationId);
  assert.deepEqual(errorLogs, []);
});

test('cancelAndWait does not complete until the session pipeline has exited', async () => {
  let pipelineExited = false;
  const orchestrator = {
    async runPipeline(_session: unknown, _brief: unknown, _tasks: unknown, signal: AbortSignal) {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => setTimeout(resolve, 25), { once: true });
      });
      pipelineExited = true;
      return { kind: 'cancelled', reason: 'deleted' };
    }
  };
  const service = new ExecutionService(
    orchestrator as never,
    { cancel() {}, cancelAll() {}, cancelAndWait() {} } as never
  );
  service.start({ id: 'session-delete', dataEpoch: 'epoch-1' } as never, { id: 'brief-delete' } as never, [], () => undefined);

  const result = await service.cancelAndWait('session-delete');

  assert.equal(result.requested, true);
  assert.equal(result.completed, true);
  assert.equal(result.timedOut, false);
  assert.equal(pipelineExited, true);
  assert.equal(service.isRunning('session-delete'), false);
});
