import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type {
  AgentDefinition,
  CapabilityDefinition,
  CompiledAgentIdentity,
  CompiledAgentProfile,
  ProfileDiagnostic,
  ProfileDiagnosticCode,
  ProfileReferenceKind,
  Skill
} from '@agent-cluster/shared';

export type ProfileBudget = {
  maxCharacters?: number;
  maxEstimatedTokens?: number;
};

export type CompileProfileInput = {
  profileMarkdown: string;
  agentCapabilityIds: string[];
  budget?: ProfileBudget;
};

export class AgentProfileCompilationError extends Error {
  readonly code = 'AGENT_PROFILE_INVALID';
  readonly diagnostics: ProfileDiagnostic[];

  constructor(diagnostics: ProfileDiagnostic[]) {
    super(diagnostics.map((item) => item.message).join('; ') || 'Agent profile is invalid.');
    this.name = 'AgentProfileCompilationError';
    this.diagnostics = diagnostics;
  }
}

export interface ProfileSkillRepository {
  findByKey(key: string): Skill | undefined;
  findById(id: string): Skill | undefined;
  list(): Skill[];
}

export interface ProfileCapabilityRepository {
  findByKey(key: string): CapabilityDefinition | undefined;
  findById(id: string): CapabilityDefinition | undefined;
  list(): CapabilityDefinition[];
}

export const PROFILE_SKILL_REPOSITORY = Symbol.for('AgentProfileCompiler.SkillRepository');
export const PROFILE_CAPABILITY_REPOSITORY = Symbol.for('AgentProfileCompiler.CapabilityRepository');

type ParsedReference = {
  kind: ProfileReferenceKind;
  key: string;
  raw: string;
  line: number;
  column: number;
  index: number;
};

const REFERENCE_REGEX = /(\\)?\$\{(skill|tool):([A-Za-z0-9_.\-:]+)\}/g;

@Injectable()
export class AgentProfileCompilerService {
  constructor(
    @Optional() @Inject(PROFILE_SKILL_REPOSITORY) private readonly skills?: ProfileSkillRepository,
    @Optional() @Inject(PROFILE_CAPABILITY_REPOSITORY) private readonly capabilities?: ProfileCapabilityRepository
  ) {}

  compileIdentity(input: { agent: AgentDefinition; budget?: ProfileBudget }): CompiledAgentIdentity {
    const { agent } = input;
    const compiled = this.compile({
      profileMarkdown: agent.profileMarkdown,
      agentCapabilityIds: agent.capabilityIds,
      budget: input.budget
    });
    const errors = compiled.diagnostics.filter((item) => item.severity === 'error');
    if (errors.length) throw new AgentProfileCompilationError(errors);

    const skillBindings = compiled.skillIds.map((skillId) => {
      const skill = this.skills?.findById(skillId);
      if (!skill) {
        throw new AgentProfileCompilationError([
          {
            severity: 'error',
            code: 'unknown_skill',
            message: `未找到 Skill: ${skillId}`,
            kind: 'skill',
            refKey: skillId
          }
        ]);
      }
      const key = skill.key ?? skillId;
      const contentHash = createHash('sha256')
        .update(JSON.stringify({
          id: skill.id,
          key,
          revision: skill.revision ?? 1,
          name: skill.name,
          description: skill.description ?? '',
          content: skill.content,
          files: skill.files
        }))
        .digest('hex');
      return {
        id: skill.id,
        key,
        revision: skill.revision ?? 1,
        contentHash
      };
    });

    return {
      agentId: agent.id,
      key: agent.key,
      name: agent.name,
      role: agent.role,
      systemPrompt: compiled.systemPrompt,
      profileHash: compiled.contentHash,
      profileRevision: agent.profileRevision,
      skillBindings,
      requestedToolIds: [...compiled.toolIds],
      requestedToolKeys: [...compiled.toolKeys],
      capabilityIds: [...agent.capabilityIds],
      knowledgeBaseIds: [...agent.defaultKnowledgeBaseIds]
    };
  }

  compile(input: CompileProfileInput): CompiledAgentProfile {
    const sourceMarkdown = input.profileMarkdown ?? '';
    const capabilityIds = new Set(input.agentCapabilityIds ?? []);
    const diagnostics: ProfileDiagnostic[] = [];
    const references = this.parseReferences(sourceMarkdown);
    const skillIds: string[] = [];
    const skillKeys: string[] = [];
    const skillRevisions: Record<string, number> = {};
    const toolIds: string[] = [];
    const toolKeys: string[] = [];
    const seen = new Map<string, number>();

    const expansions = new Map<
      number,
      { replacement: string }
    >();

    for (const ref of references) {
      const dupKey = `${ref.kind}:${ref.key}`;
      const priorCount = seen.get(dupKey) ?? 0;
      seen.set(dupKey, priorCount + 1);
      if (priorCount > 0) {
        diagnostics.push({
          severity: 'error',
          code: 'duplicate_reference',
          message: `重复引用 ${ref.kind}:${ref.key}，请仅保留一处引用。`,
          kind: ref.kind,
          refKey: ref.key,
          line: ref.line,
          column: ref.column
        });
        expansions.set(ref.index, { replacement: '' });
        continue;
      }

      if (ref.kind === 'skill') {
        const skill = this.skills?.findByKey(ref.key);
        if (!skill) {
          diagnostics.push(this.makeDiagnostic('unknown_skill', `未找到 Skill: ${ref.key}`, ref));
          expansions.set(ref.index, { replacement: '' });
          continue;
        }
        if (skill.status === 'disabled') {
          diagnostics.push(this.makeDiagnostic('disabled_skill', `Skill 已禁用: ${ref.key}`, ref));
          expansions.set(ref.index, { replacement: '' });
          continue;
        }
        skillIds.push(skill.id);
        skillKeys.push(skill.key ?? ref.key);
        skillRevisions[skill.key ?? ref.key] = skill.revision ?? 1;
        expansions.set(ref.index, { replacement: this.renderSkill(skill) });
      } else {
        const capability = this.capabilities?.findByKey(ref.key);
        if (!capability) {
          diagnostics.push(this.makeDiagnostic('unknown_tool', `未找到 Tool: ${ref.key}`, ref));
          expansions.set(ref.index, { replacement: '' });
          continue;
        }
        if (capability.kind === 'internal') {
          diagnostics.push(this.makeDiagnostic('internal_tool_not_insertable', `内部能力不允许插入到 Markdown：${ref.key}`, ref));
          expansions.set(ref.index, { replacement: '' });
          continue;
        }
        if (capability.status === 'disabled') {
          diagnostics.push(this.makeDiagnostic('disabled_tool', `Tool 已禁用: ${ref.key}`, ref));
          expansions.set(ref.index, { replacement: '' });
          continue;
        }
        if (capability.status === 'unconfigured') {
          diagnostics.push(this.makeDiagnostic('unconfigured_tool', `Tool 尚未配置执行器: ${ref.key}`, ref));
          expansions.set(ref.index, { replacement: '' });
          continue;
        }
        if (!capabilityIds.has(capability.id)) {
          diagnostics.push(
            this.makeDiagnostic('tool_capability_missing', `Agent 未授予该 Tool 的调用权限: ${ref.key}`, ref)
          );
          expansions.set(ref.index, { replacement: '' });
          continue;
        }
        toolIds.push(capability.id);
        toolKeys.push(capability.key);
        expansions.set(ref.index, { replacement: this.renderTool(capability) });
      }
    }

    const systemPrompt = this.applyReplacements(sourceMarkdown, references, expansions);
    const characterCount = systemPrompt.length;
    const estimatedTokens = Math.ceil(characterCount / 4);

    if (input.budget?.maxCharacters !== undefined && characterCount > input.budget.maxCharacters) {
      diagnostics.push({
        severity: 'error',
        code: 'profile_over_budget',
        message: `Profile 展开后 ${characterCount} 字符超过预算 ${input.budget.maxCharacters}。`
      });
    }
    if (input.budget?.maxEstimatedTokens !== undefined && estimatedTokens > input.budget.maxEstimatedTokens) {
      diagnostics.push({
        severity: 'error',
        code: 'profile_over_budget',
        message: `Profile 估算 ${estimatedTokens} tokens 超过预算 ${input.budget.maxEstimatedTokens}。`
      });
    }

    return {
      sourceMarkdown,
      systemPrompt,
      skillIds,
      toolIds,
      skillKeys,
      toolKeys,
      skillRevisions,
      diagnostics,
      contentHash: createHash('sha256').update(systemPrompt).digest('hex'),
      characterCount,
      estimatedTokens
    };
  }

  private makeDiagnostic(code: ProfileDiagnosticCode, message: string, ref: ParsedReference): ProfileDiagnostic {
    return {
      severity: 'error',
      code,
      message,
      kind: ref.kind,
      refKey: ref.key,
      line: ref.line,
      column: ref.column
    };
  }

  private renderSkill(skill: Skill): string {
    const files = skill.files.length
      ? ['Files:', ...skill.files.map((file) => `--- ${file.path} ---\n${file.content}`)].join('\n')
      : '';
    return [
      `[Skill:${skill.name}]`,
      skill.description ? `Description: ${skill.description}` : '',
      skill.content,
      files
    ]
      .filter(Boolean)
      .join('\n');
  }

  private renderTool(capability: CapabilityDefinition): string {
    return [
      `[Tool:${capability.name}]`,
      `Key: ${capability.key}`,
      `Risk: ${capability.riskLevel}`,
      capability.descriptionMarkdown ? `Description: ${capability.descriptionMarkdown}` : '',
      capability.usageMarkdown ? `Usage:\n${capability.usageMarkdown}` : ''
    ]
      .filter(Boolean)
      .join('\n');
  }

  private parseReferences(markdown: string): ParsedReference[] {
    const codeMask = this.buildCodeMask(markdown);
    const results: ParsedReference[] = [];
    REFERENCE_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REFERENCE_REGEX.exec(markdown)) !== null) {
      if (match[1] === '\\') continue;
      const index = match.index;
      if (codeMask[index]) continue;
      const kind = match[2] as ProfileReferenceKind;
      const key = match[3];
      const before = markdown.slice(0, index);
      const line = before.split('\n').length;
      const column = index - before.lastIndexOf('\n');
      results.push({
        kind,
        key,
        raw: match[0],
        line,
        column,
        index
      });
    }
    return results;
  }

  private buildCodeMask(markdown: string): boolean[] {
    const mask = new Array<boolean>(markdown.length).fill(false);
    // fenced code block via ``` ... ```
    const fenceRegex = /```[\s\S]*?```/g;
    let match: RegExpExecArray | null;
    while ((match = fenceRegex.exec(markdown)) !== null) {
      for (let i = match.index; i < match.index + match[0].length && i < mask.length; i += 1) {
        mask[i] = true;
      }
    }
    // inline code via `...`
    const inlineRegex = /`[^`\n]+`/g;
    while ((match = inlineRegex.exec(markdown)) !== null) {
      for (let i = match.index; i < match.index + match[0].length && i < mask.length; i += 1) {
        mask[i] = true;
      }
    }
    return mask;
  }

  private applyReplacements(
    source: string,
    references: ParsedReference[],
    expansions: Map<number, { replacement: string }>
  ): string {
    if (!references.length) {
      return this.unescape(source);
    }
    const sorted = [...references].sort((a, b) => a.index - b.index);
    let cursor = 0;
    let output = '';
    for (const ref of sorted) {
      const expansion = expansions.get(ref.index);
      output += source.slice(cursor, ref.index);
      output += expansion?.replacement ?? '';
      cursor = ref.index + ref.raw.length;
    }
    output += source.slice(cursor);
    return this.unescape(output);
  }

  private unescape(text: string) {
    return text.replace(/\\\$\{(skill|tool):([A-Za-z0-9_.\-:]+)\}/g, '${$1:$2}');
  }
}
