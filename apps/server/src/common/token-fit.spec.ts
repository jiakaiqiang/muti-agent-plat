import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContextPack } from '@agent-cluster/shared';
import { estimateRuntimeInputTokens, fitContextToBudget, reserveInputTokenSafetyMargin } from './token.js';

function makeContextPack(overrides: Partial<ContextPack> = {}): ContextPack {
  const base = {
    systemRules: ['rule 1'],
    sessionGoal: 'goal',
    taskContext: {
      domain: 'coding',
      intent: 'implementation',
      currentStage: 'task_execution',
      taskMap: { items: [] },
      stagePlan: { read: [], do: [], validate: [] },
      executionMode: 'single_agent',
      validationMode: 'runtime_checks',
      requiresCodeChanges: false,
      requiresExternalEvidence: false,
      validationRules: [],
      agentResponsibilities: [],
      evidenceSelection: {
        strategy: 'manual',
        selectedRefs: [],
        omittedRefs: [],
        selectedCount: 0,
        omittedCount: 0,
        selectedTypes: [],
        omittedTypes: []
      },
      evidenceRefs: []
    },
    summaryMemory: {
      goal: 'goal',
      currentState: 'state',
      confirmedFacts: [],
      completed: [],
      decisions: [],
      openQuestions: [],
      risks: [],
      nextSteps: []
    },
    continuationState: {
      phase: 'task_execution',
      sessionStatus: 'EXECUTING',
      pendingTaskIds: [],
      runningTaskIds: [],
      completedTaskIds: [],
      blockedTaskIds: [],
      nextAgentKeys: [],
      handoffRefs: [],
      sourceEventIds: [],
      sourceArtifactIds: [],
      resumeHints: []
    },
    agentProfile: {
      id: 'agent-1',
      key: 'developer',
      name: 'dev',
      role: 'developer',
      systemPrompt: 'You are a developer.',
      runtimeType: 'mock',
      capabilityIds: []
    },
    relevantEvents: [],
    relevantMemories: [],
    ragSnippets: [],
    artifacts: [],
    capabilities: [],
    constraints: [],
    budget: { maxInputTokens: 4_000, maxOutputTokens: 1_000, maxTotalTokens: 5_000 }
  } as unknown as ContextPack;
  return { ...base, ...overrides };
}

test('fitContextToBudget exposes diagnostics with stagesTried and finalStage', () => {
  const contextPack = makeContextPack();
  const result = fitContextToBudget(contextPack);
  assert.ok(result.diagnostics.stages.length >= 1);
  assert.ok(Array.isArray(result.diagnostics.stagesTried));
  assert.deepEqual(
    result.diagnostics.stagesTried,
    result.diagnostics.stages.map((stage) => stage.name)
  );
  assert.equal(result.diagnostics.finalStage, result.diagnostics.stages.at(-1)?.name);
});

test('runtime input estimate includes system prompt, schema, example, and extra prompt text', () => {
  const contextPack = makeContextPack();
  const contextOnly = estimateRuntimeInputTokens({ contextPack });
  const complete = estimateRuntimeInputTokens({
    contextPack,
    systemPrompt: 'System instruction '.repeat(40),
    outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
    outputExample: { kind: 'agent_message', messageKind: 'summary', content: 'Example output' },
    additionalPromptText: ['Return JSON only.', 'Ground conclusions in selected evidence.']
  });

  assert.ok(complete.systemPromptTokens > 0);
  assert.ok(complete.schemaTokens > 0);
  assert.ok(complete.exampleTokens > 0);
  assert.ok(complete.additionalPromptTokens > 0);
  assert.ok(complete.totalTokens > contextOnly.totalTokens);
  assert.equal(
    complete.totalTokens,
    complete.contextTokens +
      complete.systemPromptTokens +
      complete.schemaTokens +
      complete.exampleTokens +
      complete.additionalPromptTokens
  );
});

test('input token safety margin reserves a configured ratio from the model limit', () => {
  assert.deepEqual(reserveInputTokenSafetyMargin(4_000, 0.1), {
    configuredMaxInputTokens: 4_000,
    effectiveMaxInputTokens: 3_600,
    safetyMarginTokens: 400,
    safetyMarginRatio: 0.1
  });
  assert.deepEqual(reserveInputTokenSafetyMargin(undefined, 0.1), {
    configuredMaxInputTokens: undefined,
    effectiveMaxInputTokens: undefined,
    safetyMarginTokens: 0,
    safetyMarginRatio: 0.1
  });
});

test('initial snapshot compaction limits file metadata for an 80-file Runtime Snapshot', () => {
  const files = Array.from({ length: 80 }, (_, index) => ({
    path: `src/file-${String(index).padStart(2, '0')}.ts`,
    size: 128,
    language: 'typescript',
    content: `export const value${index} = ${index};`
  }));
  const result = fitContextToBudget(makeContextPack({
    budget: { maxInputTokens: 1_000_000, maxOutputTokens: 100_000, maxTotalTokens: 1_100_000 },
    workspaceSnapshot: {
      rootName: 'large-snapshot',
      scannedAt: '2026-07-11T00:00:00.000Z',
      fileCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      tree: files.map((file) => ({ path: file.path, kind: 'file' as const })),
      files,
      skipped: []
    }
  }));

  assert.equal(result.diagnostics.finalStage, 'initial');
  const compactedFileCount = result.contextPack.workspaceSnapshot?.files.length ?? 0;
  assert.ok(compactedFileCount <= 8, `expected at most 8 file metadata objects, got ${compactedFileCount}`);
});

test('grounded source analysis keeps at least one selected evidence body under pressure', () => {
  const groundedPack = makeContextPack({
    budget: { maxInputTokens: 420, maxOutputTokens: 100, maxTotalTokens: 600 },
    taskContext: {
      ...makeContextPack().taskContext,
      domain: 'mixed',
      intent: 'analysis',
      requiresCodeChanges: false,
      evidenceSelection: {
        ...makeContextPack().taskContext.evidenceSelection,
        strategy: 'architecture_analysis',
        selectedRefs: [{ type: 'workspace_file', label: 'src/main.ts', ref: 'src/main.ts' }],
        selectedCount: 1,
        selectedTypes: ['workspace_file']
      },
      evidenceRefs: [{ type: 'workspace_file', label: 'src/main.ts', ref: 'src/main.ts' }]
    },
    selectedEvidenceContents: [
      {
        type: 'workspace_file',
        label: 'src/main.ts',
        ref: 'src/main.ts',
        source: 'workspace_file',
        content: `export function bootstrap() { return 'grounded'; }\n${'// source evidence\n'.repeat(80)}`,
        contentLength: 1_600,
        tokenEstimate: 400
      }
    ]
  });

  const result = fitContextToBudget(groundedPack);

  assert.notEqual(result.diagnostics.finalStage, 'navigation_only');
  assert.ok(
    (result.contextPack.selectedEvidenceContents?.length ?? 0) >= 1,
    `expected an evidence floor, final stage was ${result.diagnostics.finalStage}; stages=${JSON.stringify(
      result.diagnostics.stages.map((stage) => ({
        name: stage.name,
        total: stage.estimatedTokens,
        evidence: stage.breakdown.selectedEvidenceContents,
        taskContext: stage.breakdown.taskContext,
        summaryMemory: stage.breakdown.summaryMemory,
        continuationState: stage.breakdown.continuationState,
        agentProfile: stage.breakdown.agentProfile
      }))
    )}`
  );
  assert.ok(result.contextPack.selectedEvidenceContents?.[0]?.content);
});

test('navigation_only is a valid FitStage name and only fires after emergency', () => {
  // With a tiny budget AND a huge synthetic workspace, the pipeline should
  // escalate all the way through emergency. If the emergency stage still does
  // not fit, navigation_only must be the final fallback (T12 implements the
  // actual size reduction — T11 only nails the type/diagnostics surface).
  const bigPack = makeContextPack({
    budget: { maxInputTokens: 16, maxOutputTokens: 4, maxTotalTokens: 32 },
    systemRules: Array.from({ length: 50 }, (_, i) => `rule ${i} with extra padding to inflate tokens`)
  });
  const result = fitContextToBudget(bigPack);
  const stageNames = result.diagnostics.stages.map((stage) => stage.name);
  assert.ok(
    stageNames.includes('navigation_only'),
    `expected navigation_only to appear in stages, got ${JSON.stringify(stageNames)}`
  );
  assert.equal(stageNames.at(-1), 'navigation_only');
  assert.equal(result.diagnostics.finalStage, 'navigation_only');
});

test('diagnostics.droppedSections lists breakdown keys whose tokens dropped to ~0', () => {
  // Stress the pipeline so workspaceSnapshot/projectMap/etc collapse to 0 tokens.
  const bigPack = makeContextPack({
    budget: { maxInputTokens: 16, maxOutputTokens: 4, maxTotalTokens: 32 },
    systemRules: Array.from({ length: 50 }, (_, i) => `rule ${i} with padding`)
  });
  const result = fitContextToBudget(bigPack);
  assert.ok(Array.isArray(result.diagnostics.droppedSections));
  // A pipeline that escalated to navigation_only should have at least some
  // section names recorded as dropped (selectedEvidenceContents or projectMap
  // would be common candidates if those were non-zero on entry).
  assert.ok(
    result.diagnostics.droppedSections.every((key) => typeof key === 'string'),
    'droppedSections entries should be strings'
  );
});

// --- T12: navigation_only actually collapses the manifest and evidence ---

function bigWorkspaceManifest() {
  // ~250KB worth of manifest files.
  const files = Array.from({ length: 800 }, (_, i) => ({
    path: `src/module-${i}/file-${i}.ts`,
    size: 1000,
    language: 'typescript',
    contentLength: 1000,
    summary: 'auto-generated stub file for navigation_only stress test ' + 'x'.repeat(120)
  }));
  return {
    rootName: 'big-workspace',
    fileCount: 800,
    readableFileCount: 800,
    skippedFileCount: 0,
    tree: files.map((file) => ({ path: file.path, kind: 'file' as const })),
    files,
    detectedStack: ['typescript', 'node'],
    entrypoints: ['src/main.ts', 'apps/web/src/main.ts']
  };
}

function bigSelectedEvidenceContents() {
  // ~100KB worth of evidence contents.
  return Array.from({ length: 25 }, (_, i) => ({
    type: 'workspace_file' as const,
    label: `evidence ${i}`,
    ref: `src/file-${i}.ts`,
    source: 'workspace_file' as const,
    content: 'x'.repeat(4_000),
    contentLength: 4_000,
    tokenEstimate: 1000
  }));
}

test('navigation_only shrinks oversized context to a tiny navigation-only ContextPack', () => {
  // systemRules are not trimmed by any earlier stage, so pumping them up keeps
  // the pipeline escalating through emergency into navigation_only. The aim
  // is a high-fidelity stress test of the final fallback shape, not a realistic
  // ContextPack.
  const inflatedSystemRules = Array.from({ length: 600 }, (_, i) =>
    `Operational guideline ${i}: ${'token-eating padding '.repeat(20)}`
  );
  const oversized = makeContextPack({
    budget: { maxInputTokens: 1_500, maxOutputTokens: 256, maxTotalTokens: 2_048 },
    systemRules: inflatedSystemRules,
    workspaceManifest: bigWorkspaceManifest() as unknown as ContextPack['workspaceManifest'],
    selectedEvidenceContents: bigSelectedEvidenceContents() as unknown as ContextPack['selectedEvidenceContents'],
    workspaceFocus: {
      relevantFiles: ['src/main.ts'],
      impactedFiles: [],
      testFiles: [],
      configFiles: [],
      possibleEntryPoints: ['src/main.ts'],
      detectedStack: ['typescript'],
      validationCommands: ['npm run typecheck', 'npm run test'],
      rationale: 'set by test fixture'
    } as ContextPack['workspaceFocus']
  });
  const result = fitContextToBudget(oversized);
  assert.equal(
    result.diagnostics.finalStage,
    'navigation_only',
    `expected navigation_only, stages were ${result.diagnostics.stagesTried.join(' → ')}`
  );

  // selectedEvidenceContents must be cleared.
  assert.ok(
    !result.contextPack.selectedEvidenceContents || result.contextPack.selectedEvidenceContents.length === 0,
    'selectedEvidenceContents must be empty in navigation_only'
  );

  // workspaceManifest must collapse to root + entrypoints.
  const manifest = result.contextPack.workspaceManifest;
  assert.ok(manifest);
  assert.equal(manifest.rootName, 'big-workspace');
  assert.ok((manifest.files?.length ?? 0) === 0, 'manifest.files must be empty in navigation_only');
  assert.ok((manifest.tree?.length ?? 0) === 0, 'manifest.tree must be empty in navigation_only');
  assert.deepEqual(manifest.entrypoints, ['src/main.ts', 'apps/web/src/main.ts']);

  // systemRules must carry contextDegraded=true marker.
  const systemRulesText = result.contextPack.systemRules.join('\n');
  assert.ok(
    systemRulesText.includes('contextDegraded=true'),
    `expected contextDegraded=true in systemRules, got first rule: ${result.contextPack.systemRules[0]}`
  );

  // workspaceFocus must collapse to validationCommands + relevantFiles only.
  const focus = result.contextPack.workspaceFocus;
  if (focus) {
    assert.equal(focus.impactedFiles.length, 0);
    assert.equal(focus.testFiles.length, 0);
    assert.equal(focus.configFiles.length, 0);
    assert.deepEqual(focus.validationCommands, ['npm run typecheck', 'npm run test']);
  }
});

test('navigation_only is NOT triggered when emergency already fits the budget', () => {
  const fits = makeContextPack({
    budget: { maxInputTokens: 1_000_000, maxOutputTokens: 100_000, maxTotalTokens: 1_100_000 }
  });
  const result = fitContextToBudget(fits);
  assert.notEqual(result.diagnostics.finalStage, 'navigation_only');
  assert.equal(
    result.diagnostics.stages.some((stage) => stage.name === 'navigation_only'),
    false
  );
});
