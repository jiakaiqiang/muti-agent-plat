import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AgentDefinition,
  CapabilityDefinition,
  CapabilityKind,
  CompiledAgentProfile,
  ProfileDiagnostic,
  ProfileReferenceKind,
  RuntimeInvocationProfileSnapshot,
  SessionDetail,
  Skill
} from './contracts.js';

test('AgentDefinition contains identity only and has no runtime compatibility fields', () => {
  const agent: AgentDefinition = {
    id: 'a-1',
    key: 'frontend',
    name: '前端开发',
    role: '实现前端页面',
    profileMarkdown: '# ${skill:vue}',
    tags: [],
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    profileRevision: 1,
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z'
  };
  assert.equal('runtimeType' in agent, false);
  assert.equal('modelId' in agent, false);
  assert.equal('skillIds' in agent, false);
});

test('Skill 增加 key/status/revision 字段', () => {
  const skill: Skill = {
    id: 'skill-1',
    key: 'element-plus-ui',
    name: 'Element Plus UI',
    content: 'Element Plus 使用规范',
    files: [],
    status: 'active',
    revision: 1,
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z'
  };
  assert.equal(skill.key, 'element-plus-ui');
  assert.equal(skill.status, 'active');
  assert.equal(skill.revision, 1);
});

test('CapabilityDefinition 新增 kind 与 systemOwned 属性', () => {
  const kinds: CapabilityKind[] = ['internal', 'tool', 'mcp', 'connector'];
  assert.equal(kinds.length, 4);

  const capability: CapabilityDefinition = {
    id: 'cap-file-write',
    key: 'tool.file_write',
    kind: 'tool',
    name: '文件写入',
    riskLevel: 'high',
    status: 'active',
    systemOwned: true
  };
  assert.equal(capability.kind, 'tool');
  assert.equal(capability.systemOwned, true);
});

test('Session carries a non-authoritative runtime preference', () => {
  const session: SessionDetail = {
    id: 's-1',
    dataEpoch: 'epoch-test',
    title: 't',
    originalInput: '',
    status: 'AGENT_DISCUSSING',
    ownerId: 'u',
    workspaceId: 'w',
    tokenUsed: 0,
    participatingAgentIds: [],
    runtimePreference: {
      preferredRuntimeType: 'generic_llm',
      preferredModelId: 'gpt-4',
      allowedRuntimeTypes: ['generic_llm', 'codex']
    },
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z'
  };
  assert.equal(session.runtimePreference?.preferredRuntimeType, 'generic_llm');
  assert.equal(session.runtimePreference?.preferredModelId, 'gpt-4');
});

test('CompiledAgentProfile 结构与诊断类型', () => {
  const kinds: ProfileReferenceKind[] = ['skill', 'tool'];
  assert.deepEqual(kinds, ['skill', 'tool']);

  const diagnostic: ProfileDiagnostic = {
    severity: 'error',
    code: 'unknown_skill',
    message: 'Skill not found: unknown-key',
    kind: 'skill',
    refKey: 'unknown-key',
    line: 3,
    column: 5
  };
  assert.equal(diagnostic.severity, 'error');
  assert.equal(diagnostic.refKey, 'unknown-key');

  const compiled: CompiledAgentProfile = {
    sourceMarkdown: '# Agent',
    systemPrompt: '# Agent',
    skillIds: [],
    toolIds: [],
    skillKeys: [],
    toolKeys: [],
    skillRevisions: {},
    diagnostics: [],
    contentHash: 'abc',
    characterCount: 7,
    estimatedTokens: 2
  };
  assert.equal(compiled.systemPrompt, '# Agent');
});

test('RuntimeInvocationProfileSnapshot records identity resources without target fields', () => {
  const snapshot: RuntimeInvocationProfileSnapshot = {
    agentId: 'a-1',
    profileHash: 'hash',
    profileRevision: 3,
    resolvedSkillIds: ['skill-1'],
    resolvedSkillRevisions: { 'skill-1': 2 },
    resolvedToolIds: ['cap-file-write']
  };
  assert.equal(snapshot.profileHash, 'hash');
  assert.equal(snapshot.profileRevision, 3);
  assert.equal('runtimeType' in snapshot, false);
  assert.equal(snapshot.resolvedSkillRevisions['skill-1'], 2);
});
