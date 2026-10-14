import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionDetail } from '@agent-cluster/shared';
import { RuntimeSwitchCoordinator, type RuntimeSwitchPorts } from './runtime-switch-coordinator.js';
import { RuntimeSwitchStore } from './runtime-switch-store.js';

function fixture() {
  const state: Record<string, any> = {};
  const session = { id: 's', status: 'EXECUTING', revision: 1, activeWorkItemId: 'w', currentTaskBriefId: 'b',
    runtimePreference: { preferredRuntimeType: 'codex', allowedRuntimeTypes: ['codex', 'claude_code'] } } as SessionDetail;
  state.sessions = [structuredClone(session)];
  state.sessionLifecyclesBySession = { s: { state: 'active', admission: 'open', generation: 1, revision: 1 } };
  const store = new RuntimeSwitchStore({
    getCollection: (key: string, fallback: unknown) => structuredClone(state[key] ?? fallback),
    mutateCollections: async (keys: string[], mutate: (draft: any) => unknown) => {
      const draft = structuredClone(state);
      const result = mutate(draft);
      for (const key of keys) if (draft[key] !== undefined) state[key] = draft[key];
      return result;
    }
  } as never);
  const calls = { stop: 0, resume: 0, busy: true };
  const ports: RuntimeSwitchPorts = {
    session: () => session, generation: () => state.sessionLifecyclesBySession.s.generation,
    preflight: async () => {}, stopped: () => true, busy: () => calls.busy,
    stop: async () => { calls.stop++; session.status = 'PAUSED'; state.sessions = [structuredClone(session)];
      state.sessionLifecyclesBySession.s.admission = 'closed'; },
    checkpoint: () => ({ version: '1.0', workItemId: 'w', briefId: 'b', sessionRevision: 1,
      createdAt: new Date().toISOString(), tasks: [], invocationIds: [] }),
    apply: async (request, handoff) => {
      const result = await store.apply(request.id, session.revision!, handoff, {
        id: 'applied', sessionId: 's', type: 'runtime_progress', createdAt: new Date().toISOString()
      } as never);
      Object.assign(session, result.session);
    },
    resume: async () => { calls.resume++; }, announce: () => {}
  };
  return { state, session, store, calls, ports, coordinator: new RuntimeSwitchCoordinator(store, ports) };
}

test('a deferred switch stops only at a boundary and commits preference, generation, checkpoint and outbox together', async () => {
  const f = fixture();
  const input = { targetRuntimeType: 'claude_code' as const, timing: 'after_step' as const, resumeAfterSwitch: true, idempotencyKey: 'one' };
  const queued = await f.coordinator.request('s', input, 'natural_language');
  assert.equal(queued.status, 'preflighted');
  assert.equal(f.calls.stop, 0);
  f.calls.busy = false;
  await f.coordinator.advance(queued);
  assert.equal(f.calls.stop, 1);
  assert.equal(f.calls.resume, 1);
  assert.equal(f.state.sessionLifecyclesBySession.s.generation, 2);
  assert.equal(f.state.sessions[0].runtimeSwitchOverride.preference.preferredRuntimeType, 'claude_code');
  assert.equal(f.state.eventOutbox.length, 1);
  assert.equal(f.store.current('s')?.handoff?.briefId, 'b');
  await f.coordinator.request('s', input, 'natural_language');
  assert.equal(f.calls.resume, 1);
});

test('restarting after resume dispatch never blindly dispatches a second execution', async () => {
  const f = fixture();
  f.ports.resume = async () => { throw new Error('simulated-process-stop'); };
  await f.coordinator.request('s', { targetRuntimeType: 'claude_code', resumeAfterSwitch: true, idempotencyKey: 'resume' }, 'chat_command');
  const request = f.state.runtimeSwitchRequestsBySession.s[0];
  request.status = 'resuming';
  delete request.error;
  const restarted = new RuntimeSwitchCoordinator(f.store, f.ports);
  await restarted.recover('s');
  assert.equal(f.store.current('s')?.status, 'failed');
  assert.equal(f.store.current('s')?.error?.code, 'RUNTIME_SWITCH_RESUME_UNKNOWN');
  assert.equal(f.calls.resume, 0);
});

test('a stale work item and cancelled session cannot take over at a later boundary', async () => {
  for (const mutation of ['work_item', 'cancel']) {
    const f = fixture();
    const request = await f.coordinator.request('s', { targetRuntimeType: 'claude_code', timing: 'after_step', idempotencyKey: mutation }, 'chat_command');
    if (mutation === 'work_item') f.session.activeWorkItemId = 'new-work';
    else f.session.status = 'CANCELLED';
    f.calls.busy = false;
    await f.coordinator.advance(request);
    assert.equal(f.store.current('s')?.status, 'failed');
    assert.equal(f.calls.stop, 0);
    assert.equal(f.calls.resume, 0);
  }
});
