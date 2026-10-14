import assert from 'node:assert/strict';
import test from 'node:test';
import type { DeliveryRecord, SessionDetail } from '@agent-cluster/shared';
import { BadRequestException } from '@nestjs/common';
import { DeliveryCoordinator } from './delivery-coordinator.js';

function fixture(exitCode: number) {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const session = {
    id: sessionId,
    codeSource: { kind: 'remote_repository', provider: 'github', repositoryUrl: 'https://github.com/o/r' },
    sourceBinding: { state: 'ready', executionLocation: 'local', deviceId: 'device-a',
      authorizationRef: 'authorization-a',
      baseSha: 'a'.repeat(40), baseBranch: 'main' },
    delivery: { sessionId, round: 1, state: 'awaiting_validation_input', version: 1,
      baseBranch: 'main', candidates: [{ id: 'candidate-a', sessionId, taskId: 'task-a',
        baseCommit: 'a'.repeat(40), treeSha: 'b'.repeat(40), ref: 'refs/ac/c/one/two/three',
        changedPaths: ['binary.dat'], createdAt: '2026-09-28T00:00:00.000Z' }],
      createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z' }
  } as SessionDetail;
  const requests: unknown[] = [];
  const events: unknown[] = [];
  const sessions = {
    get(id: string) { assert.equal(id, session.id); return session; },
    list() { return [{ id: session.id }]; },
    updateDeliveryRecord(id: string, expectedVersion: number, next: DeliveryRecord) {
      assert.equal(id, session.id);
      assert.equal(session.delivery?.version, expectedVersion);
      session.delivery = structuredClone(next);
      return session.delivery;
    }
  };
  const localRuntime = {
    async requestGitHubDelivery(deviceId: string, request: unknown) {
      assert.equal(deviceId, 'device-a');
      requests.push(request);
      if ((request as { action: string }).action === 'publish') return {
        sessionId, status: 'ok', outcome: 'published',
        taskBranch: `agent-cluster/${sessionId}/1`, commitSha: 'd'.repeat(40),
        pullRequestNumber: 12, pullRequestUrl: 'https://github.com/o/r/pull/12',
        pullRequestHeadSha: 'd'.repeat(40), ciStatus: 'pending'
      };
      return { sessionId: session.id, status: 'ok', outcome: 'validated',
        treeSha: 'c'.repeat(40), changedPaths: ['binary.dat'],
        validation: { candidateSha: 'c'.repeat(40), command: 'fixture', exitCode,
          durationMs: 5, outputSummary: 'fixture', completedAt: '2026-09-28T00:00:01.000Z' } };
    }
  };
  const coordinator = new DeliveryCoordinator(sessions as never, {} as never,
    { create(input: unknown) { events.push(input); },
      createOnce(_key: string, input: unknown) { events.push(input); } } as never,
    localRuntime as never);
  return { coordinator, session, requests, events };
}

test('a successful device validation publishes the exact candidate and waits for CI', async () => {
  const { coordinator, session, requests, events } = fixture(0);
  const result = await coordinator.validate(session.id, 1);
  assert.equal(result.state, 'awaiting_ci');
  assert.equal(result.version, 5);
  assert.equal(result.validation?.candidateSha, result.candidateTreeSha);
  assert.equal((requests[0] as { action: string }).action, 'integrate_validate');
  assert.equal((requests[1] as { action: string }).action, 'publish');
  assert.equal(result.pullRequestNumber, 12);
  assert.equal(events.length, 2);
  await assert.rejects(coordinator.validate(session.id, 1), /GITHUB_DELIVERY_NOT_READY/);
});

test('failed validation pauses push and retains the actual exit code', async () => {
  const { coordinator, session } = fixture(7);
  const result = await coordinator.validate(session.id, 1);
  assert.equal(result.state, 'needs_fix');
  assert.equal(result.validation?.exitCode, 7);
  assert.equal(result.errorCode, 'GITHUB_VALIDATION_FAILED');
});

test('restart parks an in-flight validation instead of assuming it passed', () => {
  const { coordinator, session } = fixture(0);
  session.delivery!.state = 'validating';
  coordinator.onApplicationBootstrap();
  assert.equal(session.delivery?.state, 'blocked');
  assert.equal(session.delivery?.errorCode, 'GITHUB_VALIDATION_INTERRUPTED');
});

test('restart reconciles an interrupted merge without repeating the merge operation', async () => {
  const { session, events } = fixture(0);
  const headSha = 'd'.repeat(40);
  session.delivery = { ...session.delivery!, state: 'merging', version: 9,
    commitSha: headSha, pullRequestNumber: 12,
    pullRequestUrl: 'https://github.com/o/r/pull/12',
    mergeOperationKey: 'merge:interrupted', mergeExpectedHeadSha: headSha,
    ciStatus: 'passed' };
  const calls: string[] = [];
  const sessions = {
    get() { return session; },
    list() { return [{ id: session.id }]; },
    updateDeliveryRecord(_id: string, version: number, next: DeliveryRecord) {
      assert.equal(session.delivery!.version, version);
      session.delivery = next;
      return next;
    }
  };
  const localRuntime = { async requestGitHubDelivery(_deviceId: string, request: { action: string }) {
    calls.push(request.action);
    return { outcome: 'status', pullRequestNumber: 12,
      pullRequestUrl: 'https://github.com/o/r/pull/12',
      pullRequestHeadSha: headSha, pullRequestState: 'open',
      mergeable: true, ciStatus: 'passed' };
  } };
  const coordinator = new DeliveryCoordinator(sessions as never, {} as never,
    { createOnce(_key: string, input: unknown) { events.push(input); } } as never,
    localRuntime as never);
  coordinator.onApplicationBootstrap();
  assert.equal(session.delivery.state, 'blocked');
  assert.equal(session.delivery.errorCode, 'GITHUB_MERGE_INTERRUPTED');
  const ready = await coordinator.refresh(session.id, session.delivery.version);
  assert.equal(ready.state, 'merge_ready');
  assert.deepEqual(calls, ['status']);
  assert.equal(events.length, 0);
});

test('only an explicit reviewed head can be squash merged and repeated keys return the result', async () => {
  const { session, events } = fixture(0);
  const headSha = 'd'.repeat(40);
  session.sourceBinding!.workspaceId = 'github-session:fixture';
  session.delivery = { ...session.delivery!, state: 'merge_ready', version: 9,
    commitSha: headSha, pullRequestNumber: 12,
    pullRequestUrl: 'https://github.com/o/r/pull/12', ciStatus: 'passed' };
  const calls: string[] = [];
  const localRuntime = {
    isGitHubDeviceReady() { return true; },
    async requestGitHubDelivery(_deviceId: string, request: { action: string }) {
      calls.push(request.action);
      if (request.action === 'status') return {
        outcome: 'status', pullRequestNumber: 12,
        pullRequestUrl: 'https://github.com/o/r/pull/12',
        pullRequestHeadSha: headSha, pullRequestState: 'open',
        mergeable: true, ciStatus: 'passed'
      };
      return { outcome: 'merged', mergedCommitSha: 'e'.repeat(40) };
    }
  };
  const sessions = {
    get() { return session; },
    updateDeliveryRecord(_id: string, version: number, next: DeliveryRecord) {
      assert.equal(session.delivery!.version, version);
      session.delivery = next;
      return next;
    }
  };
  const coordinator = new DeliveryCoordinator(sessions as never, {} as never,
    { createOnce(_key: string, input: unknown) { events.push(input); } } as never,
    localRuntime as never);
  await assert.rejects(coordinator.merge(session.id, 9, 'f'.repeat(40), 'merge:test01'),
    /GITHUB_MERGE_NOT_READY/);
  assert.deepEqual(calls, []);
  const merged = await coordinator.merge(session.id, 9, headSha, 'merge:test01');
  assert.equal(merged.state, 'merged');
  assert.equal(merged.mergedCommitSha, 'e'.repeat(40));
  assert.deepEqual(calls, ['status', 'merge']);
  assert.equal((await coordinator.merge(session.id, 9, headSha, 'merge:test01')).version,
    merged.version);
  assert.deepEqual(calls, ['status', 'merge']);
});

test('refresh reconciles an externally merged PR and notifies once', async () => {
  const { session, events } = fixture(0);
  const headSha = 'd'.repeat(40);
  const mergedSha = 'e'.repeat(40);
  session.delivery = { ...session.delivery!, state: 'merge_ready', version: 5,
    commitSha: headSha, pullRequestNumber: 12,
    pullRequestUrl: 'https://github.com/o/r/pull/12', ciStatus: 'passed' };
  const sessions = {
    get() { return session; },
    updateDeliveryRecord(_id: string, version: number, next: DeliveryRecord) {
      assert.equal(session.delivery!.version, version);
      session.delivery = next;
      return next;
    }
  };
  const runtime = { async requestGitHubDelivery() { return {
    outcome: 'status', pullRequestNumber: 12,
    pullRequestUrl: 'https://github.com/o/r/pull/12',
    pullRequestHeadSha: headSha, pullRequestState: 'closed',
    mergeable: true, mergedCommitSha: mergedSha
  }; } };
  const coordinator = new DeliveryCoordinator(sessions as never, {} as never,
    { createOnce(_key: string, input: unknown) { events.push(input); } } as never,
    runtime as never);
  const merged = await coordinator.refresh(session.id, 5);
  assert.equal(merged.state, 'merged');
  assert.equal(merged.mergedCommitSha, mergedSha);
  assert.equal((await coordinator.refresh(session.id, merged.version)).version, merged.version);
  assert.equal(events.length, 1);
});

test('a stale device conflict draft is returned as HTTP 409', async () => {
  const { session } = fixture(0);
  session.delivery = { ...session.delivery!, state: 'resolving_conflict',
    conflictId: 'conflict-a' };
  const coordinator = new DeliveryCoordinator({ get() { return session; } } as never,
    {} as never, {} as never, { async requestGitHubDelivery() {
      throw new BadRequestException('GITHUB_CONFLICT_VERSION_CONFLICT');
    } } as never);
  await assert.rejects(coordinator.saveConflictFile(session.id, 'conflict-a', 'file-a', {
    expectedVersion: 1, resultContent: 'stale', confirm: false
  }), (error: unknown) => {
    assert.equal((error as { getStatus(): number }).getStatus(), 409);
    return true;
  });
});
