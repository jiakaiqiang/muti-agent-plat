import assert from 'node:assert/strict';
import test from 'node:test';
import type { InvocationPlan } from '@agent-cluster/shared';
import { resolveCliToolAuthority } from './cli-tool-authority.js';

function plan(writeMode: 'none' | 'propose_changes', tools: string[]): InvocationPlan {
  return {
    executionTarget: { writeMode },
    toolCatalog: { tools: tools.map((name) => ({ name, description: '', inputSchema: {} })) }
  } as InvocationPlan;
}

test('read-only architecture invocation cannot edit, write, or run Bash', () => {
  const authority = resolveCliToolAuthority(plan('none', ['read_file', 'write_file', 'run_test']));
  assert.equal(authority.codexSandbox, 'read-only');
  assert.equal(authority.claudePermissionMode, 'plan');
  assert.doesNotMatch(authority.claudeAllowedTools, /Edit|Write|Bash/);
});

test('write and test permissions require both writeMode and explicit catalog tools', () => {
  const authority = resolveCliToolAuthority(plan('propose_changes', ['write_file', 'run_test']));
  assert.equal(authority.codexSandbox, 'workspace-write');
  assert.match(authority.claudeAllowedTools, /Edit/);
  assert.match(authority.claudeAllowedTools, /Bash/);
});
