import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionTermination } from '@agent-cluster/shared';
import { createExecutionTermination } from '../../common/execution-termination.js';
import { ExecutionService } from './execution.service.js';

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
