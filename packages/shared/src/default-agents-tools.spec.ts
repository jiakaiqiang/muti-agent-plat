import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultAgents } from './default-agents.js';

test('default implementation agents explicitly request their granted CLI tools', () => {
  const frontend = defaultAgents.find((agent) => agent.key === 'frontend');
  const backend = defaultAgents.find((agent) => agent.key === 'backend');
  const quality = defaultAgents.find((agent) => agent.key === 'test');

  for (const agent of [frontend, backend]) {
    assert.match(agent?.profileMarkdown ?? '', /\$\{tool:tool\.file_write\}/);
    assert.match(agent?.profileMarkdown ?? '', /\$\{tool:tool\.command_run\}/);
  }
  assert.doesNotMatch(quality?.profileMarkdown ?? '', /\$\{tool:tool\.file_write\}/);
  assert.match(quality?.profileMarkdown ?? '', /\$\{tool:tool\.command_run\}/);
});
