import test from 'node:test';
import assert from 'node:assert/strict';
import type { Autopilot, AutopilotRun } from '@agent-cluster/shared';
import { AutopilotService } from './autopilot.service.js';

function setup(seed: { autopilots?: Autopilot[]; runs?: AutopilotRun[]; terminalStatus?: string; blockCreate?: boolean } = {}) {
  const stored = new Map<string, unknown>([
    ['autopilots', seed.autopilots ?? []],
    ['autopilotRuns', seed.runs ?? []]
  ]);
  const sessionCreates: Array<Record<string, unknown>> = [];
  const persistence = {
    getCollection: (key: string, fallback: unknown) => stored.get(key) ?? fallback,
    setCollection: (key: string, value: unknown) => stored.set(key, value)
  };
  const sessions = {
    create: async (input: Record<string, unknown>) => {
      sessionCreates.push(input);
      if (seed.blockCreate) return new Promise<never>(() => {});
      return { session: { id: 'session-1' }, firstEvent: {} };
    },
    get: () => ({ status: seed.terminalStatus ?? 'COMPLETED' })
  };
  return {
    service: new AutopilotService(persistence as never, sessions as never),
    stored,
    sessionCreates
  };
}

test('Autopilot defaults to disabled, mock runtime and low risk', async () => {
  const { service } = setup();
  const autopilot = await service.create({ name: 'Nightly audit', prompt: 'Run a safe audit.' });
  assert.equal(autopilot.enabled, false);
  assert.equal(autopilot.runtimeType, 'mock');
  assert.equal(autopilot.riskLevel, 'low');
  await assert.rejects(() => service.trigger(autopilot.id), /disabled/);
});

test('manual duplicate triggers share one active issueguard run', async () => {
  const { service } = setup({ blockCreate: true });
  const autopilot = await service.create({ name: 'Manual', prompt: 'Run once.', enabled: true });
  const first = await service.trigger(autopilot.id);
  const second = await service.trigger(autopilot.id);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.run.id, first.run.id);
  assert.equal(first.run.issueguardKey, `autopilot:${autopilot.id}:active`);
});

test('completed inline run creates a traceable autopilot session', async () => {
  const { service, sessionCreates } = setup();
  const autopilot = await service.create({ name: 'Trace', prompt: 'Trace me.', enabled: true });
  const triggered = await service.trigger(autopilot.id);
  const completed = await service.processRun(triggered.run.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.sessionId, 'session-1');
  assert.equal(sessionCreates.length, 1);
  assert.equal(sessionCreates[0].origin, 'autopilot');
  assert.equal(sessionCreates[0].autopilotRunId, completed.id);
  assert.deepEqual(sessionCreates[0].runtimePreference, {
    preferredRuntimeType: 'mock',
    allowedRuntimeTypes: ['mock']
  });
});

test('worker restart resumes polling an existing session without creating another one', async () => {
  const now = new Date().toISOString();
  const autopilot: Autopilot = {
    id: 'autopilot-1', name: 'Restart', prompt: 'Resume.', enabled: true, runtimeType: 'mock', riskLevel: 'low',
    agentIds: [], createdAt: now, updatedAt: now
  };
  const run: AutopilotRun = {
    id: 'run-1', autopilotId: autopilot.id, trigger: 'scheduled', status: 'running',
    issueguardKey: `autopilot:${autopilot.id}:active`, sessionId: 'existing-session', createdAt: now, startedAt: now
  };
  const { service, sessionCreates } = setup({ autopilots: [autopilot], runs: [run] });
  const completed = await service.processRun(run.id);
  assert.equal(completed.status, 'completed');
  assert.equal(sessionCreates.length, 0);
});
