import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AgentDefinition,
  CapabilityDefinition,
  CompiledAgentIdentity,
  Skill
} from '@agent-cluster/shared';
import { AgentProfileCompilerService } from './agent-profile-compiler.service.js';

function skill(patch: Partial<Skill> = {}): Skill {
  return {
    id: 'skill-vue',
    key: 'vue',
    name: 'Vue',
    description: 'Vue conventions',
    content: 'Use Composition API.',
    files: [{ path: 'references/forms.md', content: 'Validate forms explicitly.' }],
    status: 'active',
    revision: 3,
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
    ...patch
  };
}

function tool(patch: Partial<CapabilityDefinition> = {}): CapabilityDefinition {
  return {
    id: 'cap-file-write',
    key: 'tool.file_write',
    kind: 'tool',
    name: 'File write',
    riskLevel: 'high',
    status: 'active',
    systemOwned: true,
    ...patch
  };
}

function agent(patch: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'agent-frontend',
    key: 'frontend',
    name: 'Frontend',
    role: 'Build UI',
    profileMarkdown: '# Frontend\n\n${skill:vue}\n\n${tool:tool.file_write}',
    tags: ['frontend'],
    status: 'active',
    capabilityIds: ['cap-file-write'],
    defaultKnowledgeBaseIds: ['kb-ui'],
    profileRevision: 7,
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
    ...patch
  };
}

function compiler(skills = [skill()], capabilities = [tool()]) {
  return new AgentProfileCompilerService(
    {
      list: () => skills,
      findByKey: (key: string) => skills.find((item) => item.key === key),
      findById: (id: string) => skills.find((item) => item.id === id)
    } as never,
    {
      list: () => capabilities,
      findByKey: (key: string) => capabilities.find((item) => item.key === key),
      findById: (id: string) => capabilities.find((item) => item.id === id)
    } as never
  );
}

function compileIdentity(service: AgentProfileCompilerService, definition = agent()): CompiledAgentIdentity {
  const candidate = service as unknown as {
    compileIdentity?: (input: { agent: AgentDefinition }) => CompiledAgentIdentity;
  };
  assert.equal(typeof candidate.compileIdentity, 'function', 'compileIdentity must be implemented');
  return candidate.compileIdentity!({ agent: definition });
}

test('compileIdentity copies stable Agent identity fields', () => {
  const result = compileIdentity(compiler());
  assert.equal(result.agentId, 'agent-frontend');
  assert.equal(result.key, 'frontend');
  assert.equal(result.role, 'Build UI');
});

test('compileIdentity never adds Runtime or model selection fields', () => {
  const result = compileIdentity(compiler()) as unknown as Record<string, unknown>;
  assert.equal('runtimeType' in result, false);
  assert.equal('modelId' in result, false);
  assert.equal('runtimeSelection' in result, false);
});

test('compileIdentity snapshots Skill id, key, revision, and content hash', () => {
  const result = compileIdentity(compiler());
  assert.equal(result.skillBindings.length, 1);
  assert.deepEqual(result.skillBindings[0].id, 'skill-vue');
  assert.deepEqual(result.skillBindings[0].key, 'vue');
  assert.deepEqual(result.skillBindings[0].revision, 3);
  assert.match(result.skillBindings[0].contentHash, /^[a-f0-9]{64}$/);
});

test('compileIdentity records requested Tool ids and stable keys', () => {
  const result = compileIdentity(compiler());
  assert.deepEqual(result.requestedToolIds, ['cap-file-write']);
  assert.deepEqual(result.requestedToolKeys, ['tool.file_write']);
});

test('compileIdentity preserves capability and knowledge grants', () => {
  const result = compileIdentity(compiler());
  assert.deepEqual(result.capabilityIds, ['cap-file-write']);
  assert.deepEqual(result.knowledgeBaseIds, ['kb-ui']);
});

test('compileIdentity records the Agent profile revision', () => {
  const result = compileIdentity(compiler());
  assert.equal(result.profileRevision, 7);
});

test('compileIdentity is deterministic for unchanged inputs', () => {
  const service = compiler();
  const first = compileIdentity(service);
  const second = compileIdentity(service);
  assert.equal(first.profileHash, second.profileHash);
  assert.deepEqual(first.skillBindings, second.skillBindings);
});

test('compileIdentity changes Skill binding hash when Skill content changes', () => {
  const first = compileIdentity(compiler([skill()]));
  const second = compileIdentity(compiler([skill({ content: 'Use script setup.', revision: 4 })]));
  assert.notEqual(first.skillBindings[0].contentHash, second.skillBindings[0].contentHash);
  assert.equal(second.skillBindings[0].revision, 4);
});

test('compileIdentity expands Skill and Tool descriptions into one system prompt', () => {
  const result = compileIdentity(compiler());
  assert.match(result.systemPrompt, /Use Composition API/);
  assert.match(result.systemPrompt, /File write/);
  assert.doesNotMatch(result.systemPrompt, /\$\{skill:|\$\{tool:/);
});

test('compileIdentity returns defensive copies of mutable grant arrays', () => {
  const definition = agent();
  const result = compileIdentity(compiler(), definition);
  definition.capabilityIds.push('cap-later');
  definition.defaultKnowledgeBaseIds.push('kb-later');
  assert.deepEqual(result.capabilityIds, ['cap-file-write']);
  assert.deepEqual(result.knowledgeBaseIds, ['kb-ui']);
});
