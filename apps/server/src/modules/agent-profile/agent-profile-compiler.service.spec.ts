import test from 'node:test';
import assert from 'node:assert/strict';
import type { CapabilityDefinition, Skill } from '@agent-cluster/shared';
import { AgentProfileCompilerService } from './agent-profile-compiler.service.js';

type SkillRepo = { list(): Skill[]; findByKey(key: string): Skill | undefined; findById(id: string): Skill | undefined };
type CapabilityRepo = {
  list(): CapabilityDefinition[];
  findByKey(key: string): CapabilityDefinition | undefined;
  findById(id: string): CapabilityDefinition | undefined;
};

function buildSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: overrides.id ?? `skill-${overrides.key ?? 'default'}`,
    key: overrides.key ?? 'element-plus-ui',
    name: overrides.name ?? 'Element Plus UI',
    content: overrides.content ?? 'Element Plus 使用规范',
    files: overrides.files ?? [],
    status: overrides.status ?? 'active',
    revision: overrides.revision ?? 1,
    createdAt: overrides.createdAt ?? '2026-07-10T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-07-10T00:00:00.000Z',
    ...overrides
  };
}

function buildCapability(overrides: Partial<CapabilityDefinition> = {}): CapabilityDefinition {
  return {
    id: overrides.id ?? `cap-${overrides.key ?? 'file-write'}`,
    key: overrides.key ?? 'tool.file_write',
    kind: overrides.kind ?? 'tool',
    name: overrides.name ?? '文件写入',
    riskLevel: overrides.riskLevel ?? 'high',
    status: overrides.status ?? 'active',
    systemOwned: overrides.systemOwned ?? true,
    descriptionMarkdown: overrides.descriptionMarkdown,
    usageMarkdown: overrides.usageMarkdown
  };
}

function makeRepos(skills: Skill[], capabilities: CapabilityDefinition[]): {
  skills: SkillRepo;
  capabilities: CapabilityRepo;
} {
  return {
    skills: {
      list: () => skills,
      findByKey: (key: string) => skills.find((s) => s.key === key),
      findById: (id: string) => skills.find((s) => s.id === id)
    },
    capabilities: {
      list: () => capabilities,
      findByKey: (key: string) => capabilities.find((c) => c.key === key),
      findById: (id: string) => capabilities.find((c) => c.id === id)
    }
  };
}

test('Compiler 解析 ${skill:key} 与 ${tool:key} 并展开内容', () => {
  const skill = buildSkill({ id: 'sk-1', key: 'vue', name: 'Vue', content: 'Vue 使用规范' });
  const tool = buildCapability({ id: 'cap-fw', key: 'tool.file_write', kind: 'tool', name: '文件写入', usageMarkdown: '使用 file_write 工具时说明范围。' });
  const { skills, capabilities } = makeRepos([skill], [tool]);
  const compiler = new AgentProfileCompilerService(skills as never, capabilities as never);
  const markdown = ['# 前端 Agent', '', '## 技能', '${skill:vue}', '', '## 工具', '${tool:tool.file_write}'].join('\n');

  const result = compiler.compile({
    profileMarkdown: markdown,
    agentCapabilityIds: [tool.id]
  });

  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(result.skillIds, ['sk-1']);
  assert.deepEqual(result.skillKeys, ['vue']);
  assert.deepEqual(result.toolIds, ['cap-fw']);
  assert.deepEqual(result.toolKeys, ['tool.file_write']);
  assert.equal(result.skillRevisions['vue'], 1);
  assert.match(result.systemPrompt, /Vue 使用规范/);
  assert.match(result.systemPrompt, /文件写入/);
  assert.doesNotMatch(result.systemPrompt, /\$\{skill:/);
  assert.doesNotMatch(result.systemPrompt, /\$\{tool:/);
  assert.ok(result.contentHash.length > 0);
  assert.ok(result.characterCount > 0);
});

test('Compiler 对未知/禁用/未配置资源产出诊断错误', () => {
  const activeSkill = buildSkill({ id: 'sk-a', key: 'vue' });
  const disabledSkill = buildSkill({ id: 'sk-d', key: 'legacy', status: 'disabled' });
  const activeTool = buildCapability({ id: 'cap-a', key: 'tool.file_write', status: 'active', kind: 'tool' });
  const unconfiguredTool = buildCapability({ id: 'cap-u', key: 'tool.deploy', status: 'unconfigured', kind: 'tool' });
  const internalTool = buildCapability({ id: 'cap-i', key: 'internal.dry_run', kind: 'internal', status: 'active' });
  const { skills, capabilities } = makeRepos([activeSkill, disabledSkill], [activeTool, unconfiguredTool, internalTool]);
  const compiler = new AgentProfileCompilerService(skills as never, capabilities as never);
  const markdown = [
    '${skill:vue}',
    '${skill:unknown-skill}',
    '${skill:legacy}',
    '${tool:tool.file_write}',
    '${tool:tool.unknown}',
    '${tool:tool.deploy}',
    '${tool:internal.dry_run}'
  ].join('\n');

  const result = compiler.compile({
    profileMarkdown: markdown,
    agentCapabilityIds: []
  });

  const codes = result.diagnostics.map((d) => d.code).sort();
  assert.ok(codes.includes('unknown_skill'));
  assert.ok(codes.includes('disabled_skill'));
  assert.ok(codes.includes('unknown_tool'));
  assert.ok(codes.includes('unconfigured_tool'));
  assert.ok(codes.includes('internal_tool_not_insertable'));
  assert.ok(codes.includes('tool_capability_missing'));
});

test('Compiler 检测重复引用', () => {
  const skill = buildSkill({ id: 'sk-1', key: 'vue' });
  const { skills, capabilities } = makeRepos([skill], []);
  const compiler = new AgentProfileCompilerService(skills as never, capabilities as never);
  const markdown = ['${skill:vue}', '', '${skill:vue}'].join('\n');
  const result = compiler.compile({ profileMarkdown: markdown, agentCapabilityIds: [] });
  const duplicates = result.diagnostics.filter((d) => d.code === 'duplicate_reference');
  assert.equal(duplicates.length, 1);
});

test('Compiler 忽略代码块和行内代码中的占位符', () => {
  const skill = buildSkill({ id: 'sk-1', key: 'vue' });
  const { skills, capabilities } = makeRepos([skill], []);
  const compiler = new AgentProfileCompilerService(skills as never, capabilities as never);
  const markdown = [
    '```md',
    '${skill:vue}',
    '```',
    '',
    '行内 `${skill:vue}` 也不解析',
    '',
    '真正引用: ${skill:vue}'
  ].join('\n');
  const result = compiler.compile({ profileMarkdown: markdown, agentCapabilityIds: [] });
  assert.deepEqual(result.skillIds, ['sk-1']);
  assert.equal(result.diagnostics.filter((d) => d.code === 'duplicate_reference').length, 0);
});

test('Compiler 支持反斜杠转义占位符', () => {
  const skill = buildSkill({ id: 'sk-1', key: 'vue' });
  const { skills, capabilities } = makeRepos([skill], []);
  const compiler = new AgentProfileCompilerService(skills as never, capabilities as never);
  const markdown = ['\\${skill:vue}', '', '${skill:vue}'].join('\n');
  const result = compiler.compile({ profileMarkdown: markdown, agentCapabilityIds: [] });
  assert.deepEqual(result.skillIds, ['sk-1']);
  assert.match(result.systemPrompt, /\$\{skill:vue\}/);
});

test('Compiler 超预算时产生 profile_over_budget 诊断', () => {
  const skill = buildSkill({ id: 'sk-1', key: 'vue', content: 'x'.repeat(200) });
  const { skills, capabilities } = makeRepos([skill], []);
  const compiler = new AgentProfileCompilerService(skills as never, capabilities as never);
  const markdown = '${skill:vue}';
  const result = compiler.compile({
    profileMarkdown: markdown,
    agentCapabilityIds: [],
    budget: { maxCharacters: 100 }
  });
  assert.ok(result.diagnostics.some((d) => d.code === 'profile_over_budget'));
});
