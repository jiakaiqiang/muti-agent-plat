import { Injectable } from '@nestjs/common';
import type {
  AgentRunPhase,
  AgentTask,
  Artifact,
  CollaborationEvent,
  ContextPack,
  ProjectMap,
  RuntimeFileChange,
  SessionDetail,
  TaskBrief,
  TaskContext
} from '@agent-cluster/shared';

export type ContextRouteInput = {
  session: SessionDetail;
  brief?: TaskBrief;
  task?: AgentTask;
  phase: AgentRunPhase;
  projectMap?: ProjectMap;
  workspaceFocus?: ContextPack['workspaceFocus'];
  relevantMemories: ContextPack['relevantMemories'];
  ragSnippets: ContextPack['ragSnippets'];
  artifacts: Artifact[];
  events: CollaborationEvent[];
  participatingAgentKeys: string[];
};

@Injectable()
export class ContextRouterService {
  route(input: ContextRouteInput): TaskContext {
    const { session, brief, task, phase, projectMap, workspaceFocus, relevantMemories, ragSnippets, artifacts, events } = input;
    const domain = session.taskDomain ?? (session.workspaceSnapshot ? 'mixed' : 'non_coding');
    const intent = session.taskIntent ?? (brief ? 'implementation' : 'analysis');
    const recentEvents = events.slice(-6);
    const decisionEvents = events
      .filter((event) => ['brief_created', 'brief_confirmed', 'post_review_completed'].includes(event.type))
      .slice(-4);
    const workspaceEvidenceFiles = this.uniqueFirstStrings(
      [
        ...(workspaceFocus?.impactedFiles ?? []),
        ...(workspaceFocus?.relevantFiles ?? []),
        ...(workspaceFocus?.configFiles ?? [])
      ],
      16
    );
    const validationRules = this.createValidationRules(domain, intent);
    const candidateEvidenceRefs: TaskContext['evidenceRefs'] = [
      { type: 'user_input', label: 'session.originalInput' },
      ...(projectMap
        ? [
            {
              type: 'project_map' as const,
              label: `${projectMap.source} project map`,
              ref: projectMap.sourceRefs[0] ?? session.workspaceSnapshot?.rootName
            }
          ]
        : []),
      ...(session.workspaceSnapshot
        ? [{ type: 'workspace_snapshot' as const, label: session.workspaceSnapshot.rootName, ref: session.workingDirectory?.name }]
        : []),
      ...workspaceEvidenceFiles.map((path) => ({
        type: 'workspace_file' as const,
        label: path,
        ref: path
      })),
      ...(workspaceFocus?.possibleEntryPoints ?? session.workspaceSnapshot?.entrypoints ?? []).slice(0, 6).map((entrypoint) => ({
        type: 'workspace_symbol' as const,
        label: entrypoint,
        ref: entrypoint
      })),
      ...(workspaceFocus?.testFiles ?? []).slice(0, 8).map((path) => ({
        type: 'test' as const,
        label: `test file: ${path}`,
        ref: path
      })),
      ...(workspaceFocus?.validationCommands ?? []).slice(0, 6).map((command) => ({
        type: 'test' as const,
        label: `validation command: ${command}`,
        ref: command
      })),
      ...artifacts.slice(-6).map((artifact) => ({
        type:
          artifact.type === 'test_report'
            ? ('test' as const)
            : artifact.type === 'code_diff'
              ? ('diff' as const)
              : domain === 'non_coding'
                ? ('document_fragment' as const)
                : ('artifact' as const),
        label: artifact.title,
        ref: artifact.id
      })),
      ...artifacts.flatMap((artifact) => this.artifactFileChangeEvidence(artifact.metadata)),
      ...relevantMemories.map((memory) => ({
        type: 'memory' as const,
        label: `${memory.scope}: ${this.shortText(memory.content, 96)}`,
        ref: memory.id
      })),
      ...ragSnippets.map((chunk) => ({
        type: this.ragEvidenceType(domain, chunk.sourceType),
        label: chunk.title,
        ref: chunk.chunkId
      })),
      ...(domain === 'non_coding'
        ? decisionEvents.map((event) => ({
            type: 'historical_decision' as const,
            label: event.type,
            ref: event.id
          }))
        : []),
      ...recentEvents.map((event) => ({
        type: this.eventEvidenceType(domain, event.type),
        label: event.type,
        ref: event.id
      }))
    ];
    const scopedCandidates = task
      ? [...candidateEvidenceRefs, { type: 'artifact' as const, label: task.title, ref: task.id }]
      : candidateEvidenceRefs;
    const evidenceSelection = this.createEvidenceSelection(session, domain, intent, phase, task, scopedCandidates);
    const evidenceRefs = evidenceSelection.selectedRefs;
    const taskMap = this.createTaskMap(session, domain, brief, projectMap, workspaceFocus, evidenceSelection);

    return {
      domain,
      intent,
      currentStage: phase,
      taskMap,
      stagePlan: this.createStagePlan(
        session,
        domain,
        intent,
        phase,
        brief,
        task,
        taskMap,
        validationRules,
        evidenceRefs
      ),
      executionMode: session.participatingAgentIds.length > 1 ? 'multi_agent' : 'single_agent',
      validationMode: domain === 'coding' || domain === 'mixed' ? 'mixed' : 'human_review',
      requiresCodeChanges: domain !== 'non_coding',
      requiresExternalEvidence: Boolean(artifacts.length || recentEvents.length || session.knowledgeBaseIds?.length),
      validationRules,
      agentResponsibilities: this.createAgentResponsibilities(input.participatingAgentKeys, domain),
      evidenceSelection,
      evidenceRefs
    };
  }

  private createStagePlan(
    session: SessionDetail,
    domain: TaskContext['domain'],
    intent: TaskContext['intent'],
    phase: AgentRunPhase,
    brief: TaskBrief | undefined,
    task: AgentTask | undefined,
    taskMap: TaskContext['taskMap'],
    validationRules: TaskContext['validationRules'],
    evidenceRefs: TaskContext['evidenceRefs']
  ): TaskContext['stagePlan'] {
    const read: TaskContext['stagePlan']['read'] = [
      {
        action: 'read',
        label: 'User goal and classified intent',
        refs: ['session.originalInput'],
        reason: `Classified as ${domain}/${intent}; keep the stage grounded in the user goal.`
      }
    ];

    if (brief) {
      read.push({
        action: 'read',
        label: `Task brief v${brief.version}`,
        refs: [brief.id],
        reason: 'Defines scope, constraints, acceptance criteria, risks, and open questions for this stage.'
      });
    }
    if (task) {
      read.push({
        action: 'read',
        label: `Current task: ${task.title}`,
        refs: [task.id],
        reason: 'Limits execution to the currently assigned unit of work.'
      });
    }

    const mapRefs = taskMap.items
      .slice(0, 8)
      .map((item) => item.ref ?? item.label)
      .filter((ref): ref is string => Boolean(ref));
    if (mapRefs.length) {
      read.push({
        action: 'read',
        label: taskMap.kind === 'project_map' ? 'Project Map focus' : 'Domain Map focus',
        refs: mapRefs,
        reason: taskMap.summary
      });
    }

    const evidenceRefsForRead = this.stageEvidenceRefs(domain, evidenceRefs);
    if (evidenceRefsForRead.length) {
      read.push({
        action: 'read',
        label: 'Minimum evidence set',
        refs: evidenceRefsForRead,
        reason: 'Use only the evidence needed for the current stage and cite these refs in outputs.'
      });
    }

    return {
      phase,
      read,
      do: this.createStageDoPlan(session, domain, intent, phase, brief, task, taskMap),
      validate: validationRules.map((rule) => ({
        action: 'validate',
        label: rule.label,
        refs: this.stageValidationRefs(rule.label, evidenceRefs),
        reason: rule.evidenceRequired
      }))
    };
  }

  private createStageDoPlan(
    session: SessionDetail,
    domain: TaskContext['domain'],
    intent: TaskContext['intent'],
    phase: AgentRunPhase,
    brief: TaskBrief | undefined,
    task: AgentTask | undefined,
    taskMap: TaskContext['taskMap']
  ): TaskContext['stagePlan']['do'] {
    const mapRef = taskMap.items.find((item) => item.ref)?.ref ?? taskMap.kind;
    const taskRef = task?.id ?? brief?.id ?? session.id;
    const scopedOutput =
      domain === 'non_coding'
        ? 'Produce evidence-grounded analysis, design, research, or documentation output without source-code changes.'
        : 'Produce scoped implementation or analysis output inside the selected Project Map boundary.';

    switch (phase) {
      case 'discussion':
        return [
          {
            action: 'do',
            label: 'Clarify goal, assumptions, and missing constraints',
            refs: [session.id],
            reason: 'Prepare enough shared state for brief generation without loading unrelated context.'
          }
        ];
      case 'brief_generation':
      case 'brief_revision':
        return [
          {
            action: 'do',
            label: 'Classify task domain and intent',
            refs: [session.id],
            reason: 'Choose the shared skeleton while allowing maps, evidence, and validation rules to diverge by domain.'
          },
          {
            action: 'do',
            label: 'Decompose work into execution, validation, and review tasks',
            refs: [mapRef],
            reason: 'Keep division of labor explicit before execution starts.'
          }
        ];
      case 'task_acceptance':
        return [
          {
            action: 'do',
            label: 'Decide claim, handoff, or rejection',
            refs: [taskRef],
            reason: 'Match currentTask to the agent responsibility and avoid accidental self-assignment.'
          }
        ];
      case 'task_execution':
        return [
          {
            action: 'do',
            label: task ? `Execute current task: ${task.title}` : 'Execute current stage task',
            refs: [taskRef, mapRef],
            reason: scopedOutput
          },
          {
            action: 'do',
            label: 'Record artifacts and next handoff',
            refs: [taskRef],
            reason: 'Outputs must remain traceable for Review Agent and Validation Agent.'
          }
        ];
      case 'post_review':
        return [
          {
            action: 'do',
            label: 'Review artifacts against brief, map boundary, and risks',
            refs: [brief?.id ?? session.id, mapRef],
            reason: 'Review is independent from execution and decides deliver, rework, or ask_user.'
          }
        ];
      case 'final_delivery':
        return [
          {
            action: 'do',
            label: 'Summarize outcome, artifacts, residual risks, and next steps',
            refs: [brief?.id ?? session.id],
            reason: 'Final delivery must connect user goal, completed work, validation evidence, and remaining gaps.'
          }
        ];
      case 'user_message_routing':
        return [
          {
            action: 'do',
            label: 'Route user message to continue, revise, pause, or ask for confirmation',
            refs: [session.id],
            reason: 'Keep long-running task state consistent across interruptions.'
          }
        ];
      default:
        return [
          {
            action: 'do',
            label: `Advance ${phase} for ${domain}/${intent}`,
            refs: [taskRef],
            reason: 'Follow the current phase boundary and Task Context Pack.'
          }
        ];
    }
  }

  private stageEvidenceRefs(domain: TaskContext['domain'], evidenceRefs: TaskContext['evidenceRefs']) {
    const preferredTypes =
      domain === 'non_coding'
        ? new Set<TaskContext['evidenceRefs'][number]['type']>([
            'document_fragment',
            'meeting_note',
            'data_table',
            'external_reference',
            'historical_decision',
            'memory',
            'user_input'
          ])
        : new Set<TaskContext['evidenceRefs'][number]['type']>([
            'project_map',
            'workspace_snapshot',
            'workspace_file',
            'workspace_symbol',
            'diff',
            'test',
            'log',
            'artifact',
            'memory',
            'user_input'
          ]);
    const preferred = evidenceRefs.filter((ref) => preferredTypes.has(ref.type));
    return (preferred.length ? preferred : evidenceRefs)
      .slice(0, 8)
      .map((ref) => ref.ref ?? ref.label)
      .filter((ref): ref is string => Boolean(ref));
  }

  private stageValidationRefs(ruleLabel: string, evidenceRefs: TaskContext['evidenceRefs']) {
    const codingTypes = new Set<TaskContext['evidenceRefs'][number]['type']>([
      'workspace_file',
      'workspace_symbol',
      'diff',
      'test',
      'log',
      'artifact'
    ]);
    const nonCodingTypes = new Set<TaskContext['evidenceRefs'][number]['type']>([
      'document_fragment',
      'meeting_note',
      'data_table',
      'external_reference',
      'historical_decision',
      'memory',
      'user_input',
      'artifact',
      'event_log'
    ]);
    const targetTypes =
      /typecheck|unit|test|build|e2e|smoke/i.test(ruleLabel)
        ? codingTypes
        : /fact|scope|trace|delivery|reasoning/i.test(ruleLabel)
          ? nonCodingTypes
          : new Set<TaskContext['evidenceRefs'][number]['type']>();
    const direct = targetTypes.size ? evidenceRefs.filter((ref) => targetTypes.has(ref.type)) : [];
    return (direct.length ? direct : evidenceRefs)
      .slice(0, 6)
      .map((ref) => ref.ref ?? ref.label)
      .filter((ref): ref is string => Boolean(ref));
  }

  private createEvidenceSelection(
    session: SessionDetail,
    domain: TaskContext['domain'],
    intent: TaskContext['intent'],
    phase: AgentRunPhase,
    task: AgentTask | undefined,
    candidateRefs: TaskContext['evidenceRefs']
  ): TaskContext['evidenceSelection'] {
    const uniqueCandidates = this.uniqueEvidenceRefs(candidateRefs);
    const maxEvidenceRefs = phase === 'brief_generation' || phase === 'discussion' ? 18 : domain === 'non_coding' ? 24 : 28;
    const ranked = uniqueCandidates
      .map((ref, index) => ({
        ref,
        index,
        score: this.evidenceRefScore(domain, intent, phase, task, ref)
      }))
      .sort((left, right) => right.score - left.score || left.index - right.index);
    const selected = ranked
      .slice(0, maxEvidenceRefs)
      .sort((left, right) => left.index - right.index)
      .map((item) => ({
        ...item.ref,
        estimatedTokens: this.estimateEvidenceTokens(item.ref),
        selectionReason: this.evidenceSelectionReason(domain, intent, phase, item.ref, item.score)
      }));
    const omitted = ranked
      .slice(maxEvidenceRefs)
      .sort((left, right) => left.index - right.index)
      .map((item) => ({
        ...item.ref,
        estimatedTokens: this.estimateEvidenceTokens(item.ref),
        omissionReason: `Omitted by ${domain} ${phase} minimal-evidence budget after ${maxEvidenceRefs} selected refs.`
      }));
    return {
      phase,
      strategy:
        domain === 'non_coding'
          ? 'non_coding_minimal'
          : domain === 'mixed'
            ? 'mixed_minimal'
            : 'coding_minimal',
      query: [session.originalInput, task?.title, task?.description].filter(Boolean).join(' | '),
      maxEvidenceRefs,
      selectedCount: selected.length,
      omittedCount: omitted.length,
      selectedTypes: Array.from(new Set(selected.map((ref) => ref.type))),
      omittedTypes: Array.from(new Set(omitted.map((ref) => ref.type))),
      selectedRefs: selected,
      omittedRefs: omitted.slice(0, 8),
      rules: this.evidenceSelectionRules(domain, intent, phase)
    };
  }

  private evidenceSelectionRules(
    domain: TaskContext['domain'],
    intent: TaskContext['intent'],
    phase: AgentRunPhase
  ) {
    const shared = [
      `Select only refs needed for ${phase}.`,
      'Always keep user goal, current task, prior artifacts, memory, RAG, or event refs when they ground the current output.',
      'Keep omitted refs traceable by count/type, but do not send full unrelated history.'
    ];
    if (domain === 'non_coding') {
      return [
        ...shared,
        'Prefer document fragments, meeting notes, data tables, external references, historical decisions, and memory.',
        'Use fact, scope, traceability, and delivery completeness rules instead of implementation-only evidence.'
      ];
    }
    if (domain === 'mixed') {
      return [
        ...shared,
        'Prefer workspace files/symbols, diffs, tests, artifacts, memory, and document refs that link planning to implementation.',
        'Keep both Project Map and analysis evidence when validation must bridge coding and non-coding work.'
      ];
    }
    return [
      ...shared,
      `Prefer workspace files, symbols, logs, tests, diffs, and artifacts for ${intent}.`,
      'Keep validation evidence aligned with typecheck, tests, build, and smoke/e2e paths.'
    ];
  }

  private estimateEvidenceTokens(ref: TaskContext['evidenceRefs'][number]) {
    return Math.max(1, Math.ceil(JSON.stringify(ref).length / 4));
  }

  private evidenceSelectionReason(
    domain: TaskContext['domain'],
    intent: TaskContext['intent'],
    phase: AgentRunPhase,
    ref: TaskContext['evidenceRefs'][number],
    score: number
  ) {
    if (ref.type === 'user_input') return 'Always selected because the user goal anchors every phase.';
    if (ref.type === 'project_map') return 'Selected to keep repository/module routing explicit without loading the whole project.';
    if (ref.type === 'workspace_snapshot') return 'Selected to ground file-level reasoning in the scanned workspace.';
    if (domain !== 'non_coding' && ['workspace_file', 'workspace_symbol', 'diff', 'test', 'log'].includes(ref.type)) {
      return `Selected for ${domain}/${intent}/${phase} because it is direct coding evidence. Score=${score}.`;
    }
    if (domain === 'non_coding' && ['document_fragment', 'meeting_note', 'data_table', 'external_reference', 'historical_decision'].includes(ref.type)) {
      return `Selected for non-coding traceability and fact/scope validation. Score=${score}.`;
    }
    return `Selected by ${domain} ${phase} minimal-evidence ranking. Score=${score}.`;
  }

  private evidenceRefScore(
    domain: TaskContext['domain'],
    intent: TaskContext['intent'],
    phase: AgentRunPhase,
    task: AgentTask | undefined,
    ref: TaskContext['evidenceRefs'][number]
  ) {
    let score = ref.type === 'user_input' ? 120 : ref.ref && task?.id === ref.ref ? 115 : 20;
    const codingPriority = new Map<TaskContext['evidenceRefs'][number]['type'], number>([
      ['workspace_snapshot', 90],
      ['project_map', 89],
      ['workspace_file', 88],
      ['workspace_symbol', 86],
      ['diff', 84],
      ['test', 82],
      ['log', 80],
      ['artifact', 72],
      ['memory', 68],
      ['event_log', 52],
      ['external_reference', 48]
    ]);
    const nonCodingPriority = new Map<TaskContext['evidenceRefs'][number]['type'], number>([
      ['document_fragment', 92],
      ['meeting_note', 90],
      ['data_table', 88],
      ['external_reference', 84],
      ['historical_decision', 82],
      ['memory', 80],
      ['artifact', 74],
      ['event_log', 58],
      ['user_input', 120]
    ]);
    score += (domain === 'non_coding' ? nonCodingPriority : codingPriority).get(ref.type) ?? 30;
    if (domain === 'mixed' && ['document_fragment', 'external_reference', 'memory'].includes(ref.type)) score += 12;
    if (phase === 'task_execution' && ['workspace_file', 'document_fragment', 'memory', 'artifact'].includes(ref.type)) score += 10;
    if ((phase === 'post_review' || intent === 'validation') && ['test', 'diff', 'log', 'artifact', 'document_fragment'].includes(ref.type)) {
      score += 12;
    }
    if (intent === 'troubleshooting' && ['log', 'test', 'diff', 'event_log'].includes(ref.type)) score += 16;
    return score;
  }

  private createTaskMap(
    session: SessionDetail,
    domain: TaskContext['domain'],
    brief: TaskBrief | undefined,
    projectMap: ProjectMap | undefined,
    focus: ContextPack['workspaceFocus'],
    evidenceSelection: TaskContext['evidenceSelection']
  ): TaskContext['taskMap'] {
    if (domain === 'coding' || domain === 'mixed') {
      const moduleFiles = this.uniqueFirstStrings(
        [
          ...(projectMap?.modules.flatMap((module) => [module.path, ...module.entrypoints]) ?? []),
          ...(focus?.impactedFiles ?? []),
          ...(focus?.relevantFiles ?? [])
        ],
        10
      );
      return {
        kind: 'project_map',
        summary: projectMap
          ? `Project Map (${projectMap.source}) built from ${projectMap.sourceRefs.length} source refs and ${projectMap.modules.length} modules.`
          : focus?.rationale ?? 'Project Map built from workspace snapshot and detected entrypoints.',
        items: [
          ...moduleFiles.map((path) => ({
            type: 'module' as const,
            label: path,
            ref: path,
            reason: 'Relevant or impacted workspace file selected from Project Map focus.'
          })),
          ...(focus?.possibleEntryPoints ?? []).slice(0, 4).map((path) => ({
            type: 'entrypoint' as const,
            label: path,
            ref: path,
            reason: 'Detected project entrypoint.'
          })),
          ...(focus?.detectedStack ?? []).slice(0, 5).map((stack) => ({
            type: 'key_material' as const,
            label: stack,
            reason: 'Detected technology stack.'
          })),
          ...(projectMap?.modules ?? []).slice(0, 6).flatMap((module) =>
            module.contracts.slice(0, 3).map((path) => ({
              type: 'key_material' as const,
              label: `contract: ${path}`,
              ref: path,
              reason: `Contract or type boundary discovered for ${module.name}.`
            }))
          ),
          ...(focus?.configFiles ?? []).slice(0, 6).map((path) => ({
            type: 'key_material' as const,
            label: `config: ${path}`,
            ref: path,
            reason: 'Configuration or project instruction file needed to understand the implementation boundary.'
          })),
          ...this.taskMapEvidenceItems(evidenceSelection, domain),
          {
            type: 'boundary' as const,
            label: session.workingDirectory?.name ?? session.workspaceSnapshot?.rootName ?? 'workspace snapshot',
            ref: session.workingDirectory?.path,
            reason: 'Runtime must stay within the selected workspace evidence and capability policy.'
          },
          ...(focus?.testFiles ?? []).slice(0, 6).map((path) => ({
            type: 'validation_path' as const,
            label: `test file: ${path}`,
            ref: path,
            reason: 'Detected test file that can validate or guide the implementation.'
          })),
          ...(projectMap?.validationCommands ?? focus?.validationCommands ?? []).slice(0, 6).map((command) => ({
            type: 'validation_path' as const,
            label: command,
            ref: command,
            reason: 'Detected package script suitable for validation.'
          })),
          ...this.createValidationRules(domain, session.taskIntent ?? 'implementation').map((rule) => ({
            type: 'validation_path' as const,
            label: rule.label,
            reason: rule.evidenceRequired
          }))
        ]
      };
    }

    return {
      kind: 'domain_map',
      summary: 'Domain Map built from user goal, brief scope, artifacts, event decisions, and knowledge evidence.',
      items: [
        {
          type: 'boundary' as const,
          label: 'non-coding task boundary',
          reason: 'No source-code edits are required unless a later user request explicitly changes scope.'
        },
        {
          type: 'entrypoint' as const,
          label: this.shortText(session.originalInput, 120),
          reason: 'User goal is the analysis entrypoint for the Domain Map.'
        },
        ...(brief?.scope ?? []).slice(0, 4).map((item) => ({
          type: 'module' as const,
          label: item,
          reason: 'Analysis scope from the current brief.'
        })),
        ...this.taskMapEvidenceItems(evidenceSelection, domain),
        ...(brief?.acceptanceCriteria ?? []).slice(0, 4).map((item) => ({
          type: 'validation_path' as const,
          label: item,
          reason: 'Acceptance criterion for non-coding delivery.'
        })),
        ...this.createValidationRules(domain, session.taskIntent ?? 'analysis').map((rule) => ({
          type: 'validation_path' as const,
          label: rule.label,
          reason: rule.evidenceRequired
        }))
      ]
    };
  }

  private taskMapEvidenceItems(
    evidenceSelection: TaskContext['evidenceSelection'],
    domain: TaskContext['domain']
  ): TaskContext['taskMap']['items'] {
    const materialTypes =
      domain === 'non_coding'
        ? new Set<TaskContext['evidenceRefs'][number]['type']>([
            'document_fragment',
            'meeting_note',
            'data_table',
            'external_reference',
            'historical_decision',
            'memory',
            'artifact'
          ])
        : new Set<TaskContext['evidenceRefs'][number]['type']>([
            'artifact',
            'diff',
            'test',
            'log',
            'memory',
            'external_reference',
            'document_fragment'
          ]);
    return evidenceSelection.selectedRefs
      .filter((ref) => materialTypes.has(ref.type))
      .slice(0, 8)
      .map((ref) => ({
        type: 'key_material' as const,
        label: `${ref.type}: ${ref.label}`,
        ref: ref.ref,
        reason: `Selected by evidenceSelection (${evidenceSelection.strategy}) for the current ${domain} stage.`
      }));
  }

  private createValidationRules(domain: TaskContext['domain'], intent: TaskContext['intent']): TaskContext['validationRules'] {
    if (domain === 'non_coding') {
      return [
        { label: 'Fact consistency', evidenceRequired: 'Every factual conclusion links to user input, retrieved material, or a stated assumption.' },
        { label: 'Scope consistency', evidenceRequired: 'Output covers the agreed brief scope and does not add hidden implementation work.' },
        { label: 'Traceability', evidenceRequired: 'Key conclusions cite taskContext.evidenceRefs, artifacts, or event decisions.' },
        { label: 'Delivery completeness', evidenceRequired: 'Final output includes answer/plan, risks, open questions, and next steps.' }
      ];
    }
    const rules: TaskContext['validationRules'] = [
      { label: 'Typecheck', evidenceRequired: '`npm run typecheck` or equivalent typed contract evidence.' },
      { label: 'Unit or workspace tests', evidenceRequired: '`npm run test` or a scoped test command covering the changed surface.' },
      { label: 'Build', evidenceRequired: '`npm run build` or equivalent build output for user-facing/runtime changes.' }
    ];
    if (domain === 'mixed' || intent === 'validation') {
      rules.push({ label: 'E2E or smoke flow', evidenceRequired: 'A smoke/e2e run proving orchestration, UI, or runtime behavior.' });
      rules.push({ label: 'Reasoning trace', evidenceRequired: 'Planning artifact and implementation evidence refer to the same user goal.' });
    }
    return rules;
  }

  private createAgentResponsibilities(
    participatingAgentKeys: string[],
    domain: TaskContext['domain']
  ): TaskContext['agentResponsibilities'] {
    const choose = (preferredKeys: string[], fallback: string) =>
      preferredKeys.find((key) => participatingAgentKeys.includes(key)) ?? fallback;
    const executionKey =
      domain === 'non_coding'
        ? choose(['requirements', 'product-manager', 'architect'], 'requirements')
        : choose(['backend', 'frontend', 'architect', 'requirements'], 'backend');
    const validationKey = choose(['test', 'review'], 'test');
    const reviewKey = choose(['review', 'test'], 'review');
    return [
      { role: 'execution', agentKey: executionKey },
      { role: 'validation', agentKey: validationKey, independentFrom: [executionKey] },
      { role: 'review', agentKey: reviewKey, independentFrom: Array.from(new Set([executionKey, validationKey])) }
    ];
  }

  private artifactFileChangeEvidence(metadata: Record<string, unknown>): TaskContext['evidenceRefs'] {
    if (!Array.isArray(metadata.fileChanges)) return [];
    return metadata.fileChanges
      .filter((change): change is RuntimeFileChange => Boolean(change) && typeof (change as RuntimeFileChange).path === 'string')
      .slice(0, 12)
      .map((change) => ({
        type: 'diff' as const,
        label: `${change.operation}: ${change.path}`,
        ref: change.path
      }));
  }

  private eventEvidenceType(domain: TaskContext['domain'], type: string): TaskContext['evidenceRefs'][number]['type'] {
    if (type === 'runtime_failed' || type === 'error_reported' || type === 'tool_failed') return 'log';
    if (type === 'post_review_completed' || type === 'task_completed') return 'test';
    if (domain === 'non_coding' && (type === 'brief_created' || type === 'brief_confirmed')) return 'historical_decision';
    return 'event_log';
  }

  private ragEvidenceType(domain: TaskContext['domain'], sourceType?: string): TaskContext['evidenceRefs'][number]['type'] {
    if (sourceType === 'meeting_note') return 'meeting_note';
    if (sourceType === 'data_table') return 'data_table';
    if (sourceType === 'external_reference') return 'external_reference';
    return domain === 'non_coding' ? 'document_fragment' : 'external_reference';
  }

  private uniqueEvidenceRefs(refs: TaskContext['evidenceRefs']): TaskContext['evidenceRefs'] {
    const seen = new Set<string>();
    return refs.filter((ref) => {
      const key = `${ref.type}:${ref.label}:${ref.ref ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private uniqueFirstStrings(values: string[], limit: number) {
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const value of values) {
      const normalized = value.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      unique.push(normalized);
      if (unique.length >= limit) break;
    }
    return unique;
  }

  private shortText(value: string, maxLength: number) {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 1))}...` : normalized;
  }
}
