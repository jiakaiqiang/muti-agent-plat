import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import { LocalRuntimeConnectionService } from './local-runtime-connection.service.js';
import { makeInvocationPlan } from '../runtimes/invocation-plan.fixture.js';

test('probe is read-only, negotiated, bound to device/workspace/generation/epoch and cleans its pending challenge', async () => {
  const service = new LocalRuntimeConnectionService({} as never, {} as never, {} as never, {} as never);
  const subject = service as any;
  const messages: any[] = [];
  const client = { clientId: 'connection', deviceId: 'device', hello: { requestHealthProtocol: 1 },
    socket: { readyState: WebSocket.OPEN, send: (line: string) => messages.push(JSON.parse(line)) } };
  const plan = makeInvocationPlan();
  plan.requestHealth = { sessionId: plan.sessionId, operationId: 'operation', invocationId: plan.invocationId, sessionGeneration: 2, observerEpoch: 'epoch' };
  subject.workspaces.set(plan.contextEnvelope.L0.workspace.workspaceId, { deviceId: 'device' });
  subject.clientsByDeviceId.set('device', client);
  const pending = service.probeInvocation(plan);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'local_runtime.invocation.probe');
  const payload = { ...messages[0].payload, status: 'ok', processStatus: 'alive', requestStatus: 'unknown', processInstanceId: 'instance' };
  for (const patch of [{ deviceId: 'wrong' }, { workspaceId: 'wrong' }, { sessionGeneration: 1 }, { observerEpoch: 'old' }]) {
    subject.handleMessage(client, { kind: 'local_runtime.invocation.probe.result', payload: { ...payload, ...patch } });
    assert.equal(subject.invocationProbes.size, 1);
  }
  subject.handleMessage(client, { kind: 'local_runtime.invocation.probe.result', payload });
  assert.equal((await pending)?.requestStatus, 'unknown');
  assert.equal(subject.invocationProbes.size, 0);
  subject.handleMessage(client, { kind: 'local_runtime.invocation.probe.result', payload });
  assert.equal(messages.length, 1, 'no start, resume or extra model request');
  client.hello.requestHealthProtocol = 0;
  assert.equal(await service.probeInvocation(plan), undefined);
  assert.equal(messages.length, 1);
});
