import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHistoricalMessageContext, resolveHistoricalAgent, resolveHistoricalSkill } from './historical-context.js';

test('historical Skill tag remains visible while execution resolves to the newest active revision', () => {
  const result = resolveHistoricalSkill(
    { id: 'old', key: 'review', name: '旧 Review', revision: 1, scope: 'group', scopeId: 'g1', status: 'disabled' },
    [
      { id: 'new-1', key: 'review', name: 'Review v2', revision: 2, scope: 'group', scopeId: 'g1', status: 'active' },
      { id: 'wrong-scope', key: 'review', name: 'Other', revision: 9, scope: 'group', scopeId: 'g2', status: 'active' }
    ]
  );
  assert.equal(result?.ref.name, '旧 Review');
  assert.equal(result?.current?.revision, 2);
  assert.equal(result?.executable, true);
});

test('deleted or disabled Skill and Agent preserve tags but are execution guarded', () => {
  const skill = resolveHistoricalSkill({ id: 'missing', key: 'gone', name: 'Gone', status: 'active' }, []);
  const agent = resolveHistoricalAgent({ id: 'agent-old', key: 'old', name: 'Old Agent' }, [
    { id: 'agent-old', key: 'old', name: 'Old Agent', status: 'disabled' }
  ]);
  assert.equal(skill?.ref.name, 'Gone');
  assert.equal(skill?.executable, false);
  assert.equal(agent.ref.name, 'Old Agent');
  assert.equal(agent.executable, false);
});

test('new Agent history access is read-only and includes pre-join attachments without reviving deleted bytes', () => {
  const result = buildHistoricalMessageContext({
    agents: [{ id: 'agent-1', name: 'New Agent' }],
    attachments: [
      { id: 'file-1', sessionId: 's', kind: 'file', fileName: 'notes.txt', mimeType: 'text/plain', sizeBytes: 1, uploadStatus: 'ready', createdAt: '2026-09-01T00:00:00.000Z' },
      { id: 'file-2', sessionId: 's', kind: 'file', fileName: 'deleted.txt', mimeType: 'text/plain', sizeBytes: 1, uploadStatus: 'deleted', createdAt: '2026-09-01T00:00:00.000Z' }
    ],
    currentAgents: [{ id: 'agent-1', name: 'New Agent', status: 'active' }]
  });
  assert.equal(result.historyReadable, true);
  assert.equal(result.agents[0]?.executable, true);
  assert.equal(result.attachments[0]?.executable, true);
  assert.equal(result.attachments[1]?.executable, false);
  assert.equal(result.attachments[1]?.reason, 'deleted');
});
