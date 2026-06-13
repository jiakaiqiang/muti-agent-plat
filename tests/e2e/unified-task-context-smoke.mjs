import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address?.port) {
          resolve(String(address.port));
        } else {
          reject(new Error('Could not allocate a free port'));
        }
      });
    });
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: options.stdio ?? 'inherit',
      env: { ...process.env, ...(options.env ?? {}) }
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
    child.on('error', reject);
  });
}

async function waitForServer(apiBase) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiBase}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Server did not become ready');
}

async function startServer() {
  const port = await findFreePort();
  const apiBase = `http://127.0.0.1:${port}/api`;
  const server = spawn(process.execPath, ['apps/server/dist/apps/server/src/main.js'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SERVER_PORT: port,
      AGENT_CLUSTER_PERSISTENCE: 'false',
      DEFAULT_AGENT_RUNTIME_TYPE: 'mock',
      MOCK_RUNTIME_ENABLED: 'true',
      LLM_DRY_RUN: 'true',
      LLM_MOCK_FALLBACK: 'true'
    }
  });
  server.stdout.on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await waitForServer(apiBase);
  return { apiBase, server };
}

async function stopServer(server) {
  if (!server.killed) server.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    server.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function api(apiBase, path, init) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init
  });
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function waitForBrief(apiBase, sessionId) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const detail = await api(apiBase, `/sessions/${sessionId}`);
    if (detail.data.currentTaskBriefId) return detail.data.currentTaskBriefId;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Brief was not created in time');
}

async function waitForContextPack(apiBase, sessionId, predicate, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const contextPacks = await api(apiBase, `/sessions/${sessionId}/debug/context-packs`);
    const found = contextPacks.data.items.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Context pack was not created in time: ${label}`);
}

function validationEvidenceFromArtifact(artifact) {
  if (artifact?.metadata?.validationEvidence) {
    return artifact.metadata.validationEvidence;
  }
  const outputArtifacts = artifact?.metadata?.output?.changedArtifacts ?? [];
  const runtimeArtifacts = artifact?.metadata?.runtimeArtifacts ?? [];
  return [...outputArtifacts, ...runtimeArtifacts].find((item) => item?.metadata?.validationEvidence)?.metadata?.validationEvidence;
}

async function waitForValidationEvidenceArtifact(apiBase, sessionId, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const artifacts = await api(apiBase, `/sessions/${sessionId}/artifacts`);
    const found = artifacts.data.items
      .map((artifact) => ({ artifact, validationEvidence: validationEvidenceFromArtifact(artifact) }))
      .find((item) => item.validationEvidence);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Validation evidence artifact was not created in time: ${label}`);
}

async function waitForSummaryMemoryCheckpoints(apiBase, sessionId, minCount, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const summary = await api(apiBase, `/sessions/${sessionId}/debug/summary-memory`);
    if (summary.data.items.length >= minCount) return summary.data;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Summary memory checkpoints were not created in time: ${label}`);
}

function flattenStageRefs(stagePlan) {
  return [...(stagePlan?.read ?? []), ...(stagePlan?.do ?? []), ...(stagePlan?.validate ?? [])].flatMap((item) => item.refs ?? []);
}

function assertStagePlanShape(stagePlan, phase, label) {
  if (!stagePlan) {
    throw new Error(`Expected ${label} stagePlan`);
  }
  if (stagePlan.phase !== phase) {
    throw new Error(`Expected ${label} stagePlan phase ${phase}, got ${stagePlan.phase}`);
  }
  for (const action of ['read', 'do', 'validate']) {
    if (!Array.isArray(stagePlan[action]) || stagePlan[action].length < 1) {
      throw new Error(`Expected ${label} stagePlan.${action} to be non-empty: ${JSON.stringify(stagePlan)}`);
    }
    if (!stagePlan[action].every((item) => item.action === action && item.label)) {
      throw new Error(`Expected ${label} stagePlan.${action} items to carry action and label: ${JSON.stringify(stagePlan[action])}`);
    }
  }
}

function assertStagePlanCitesEvidence(stagePlan, evidenceRefs, evidenceTypes, label) {
  const stageRefs = new Set(flattenStageRefs(stagePlan));
  const candidateRefs = evidenceRefs
    .filter((item) => evidenceTypes.includes(item.type))
    .map((item) => item.ref ?? item.label)
    .filter(Boolean);
  if (!candidateRefs.some((ref) => stageRefs.has(ref))) {
    throw new Error(`Expected ${label} stagePlan to cite current evidence refs: ${JSON.stringify({ stagePlan, evidenceRefs })}`);
  }
}

function assertContinuationStateShape(contextPack, phase, label) {
  const state = contextPack.continuationState;
  if (!state) {
    throw new Error(`Expected ${label} continuationState`);
  }
  if (state.phase !== phase) {
    throw new Error(`Expected ${label} continuationState phase ${phase}, got ${state.phase}`);
  }
  for (const key of [
    'pendingTaskIds',
    'runningTaskIds',
    'completedTaskIds',
    'blockedTaskIds',
    'nextAgentKeys',
    'handoffRefs',
    'sourceEventIds',
    'sourceArtifactIds',
    'resumeHints'
  ]) {
    if (!Array.isArray(state[key])) {
      throw new Error(`Expected ${label} continuationState.${key} to be an array: ${JSON.stringify(state)}`);
    }
  }
  if (contextPack.currentTask?.id && state.activeTaskId !== contextPack.currentTask.id) {
    throw new Error(`Expected ${label} active task to match currentTask: ${JSON.stringify({ state, currentTask: contextPack.currentTask })}`);
  }
  if (!state.activeAgentKey) {
    throw new Error(`Expected ${label} continuationState.activeAgentKey: ${JSON.stringify(state)}`);
  }
  if (!state.resumeHints.length) {
    throw new Error(`Expected ${label} continuationState.resumeHints: ${JSON.stringify(state)}`);
  }
}

function assertAgentResponsibilitiesIndependent(taskContext, label) {
  const byRole = new Map((taskContext.agentResponsibilities ?? []).map((item) => [item.role, item]));
  const execution = byRole.get('execution');
  const validation = byRole.get('validation');
  const review = byRole.get('review');
  if (!execution || !validation || !review) {
    throw new Error(`Expected ${label} execution, validation, and review responsibilities: ${JSON.stringify(taskContext.agentResponsibilities)}`);
  }
  if (validation.agentKey === execution.agentKey) {
    throw new Error(`Expected ${label} Validation Agent to be independent from Execution Agent: ${JSON.stringify(taskContext.agentResponsibilities)}`);
  }
  if (!(validation.independentFrom ?? []).includes(execution.agentKey)) {
    throw new Error(`Expected ${label} validation responsibility to name execution as independentFrom: ${JSON.stringify(taskContext.agentResponsibilities)}`);
  }
  if (review.agentKey === execution.agentKey) {
    throw new Error(`Expected ${label} Review Agent to be independent from Execution Agent: ${JSON.stringify(taskContext.agentResponsibilities)}`);
  }
  if (!(review.independentFrom ?? []).includes(execution.agentKey)) {
    throw new Error(`Expected ${label} review responsibility to name execution as independentFrom: ${JSON.stringify(taskContext.agentResponsibilities)}`);
  }
}

function assertValidationEvidenceIndependence(validationEvidence, taskContext, label) {
  const byRole = new Map((taskContext.agentResponsibilities ?? []).map((item) => [item.role, item]));
  const execution = byRole.get('execution');
  const validation = byRole.get('validation');
  if (!execution || !validation) {
    throw new Error(`Expected ${label} execution and validation responsibilities: ${JSON.stringify(taskContext.agentResponsibilities)}`);
  }
  if (validationEvidence.validatorAgentKey !== validation.agentKey) {
    throw new Error(`Expected ${label} validatorAgentKey ${validation.agentKey}, got ${validationEvidence.validatorAgentKey}`);
  }
  if (validationEvidence.validatorAgentKey === execution.agentKey) {
    throw new Error(`Expected ${label} validation evidence to be produced by a non-execution agent: ${JSON.stringify(validationEvidence)}`);
  }
  if (!Array.isArray(validationEvidence.independentFromAgentKeys)) {
    throw new Error(`Expected ${label} validation evidence independentFromAgentKeys: ${JSON.stringify(validationEvidence)}`);
  }
  if (!validationEvidence.independentFromAgentKeys.includes(execution.agentKey)) {
    throw new Error(`Expected ${label} validation evidence to name execution as independentFrom: ${JSON.stringify(validationEvidence)}`);
  }
}

function evidenceKey(ref) {
  return `${ref.type}:${ref.label}:${ref.ref ?? ''}`;
}

function assertEvidenceSelectionShape(taskContext, strategy, label) {
  const selection = taskContext.evidenceSelection;
  if (!selection) {
    throw new Error(`Expected ${label} evidenceSelection`);
  }
  if (selection.strategy !== strategy) {
    throw new Error(`Expected ${label} evidence selection strategy ${strategy}, got ${selection.strategy}`);
  }
  if (selection.phase !== taskContext.currentStage) {
    throw new Error(`Expected ${label} evidence selection phase to match currentStage: ${JSON.stringify(selection)}`);
  }
  if (!selection.query || !selection.rules?.length) {
    throw new Error(`Expected ${label} evidence selection query and rules: ${JSON.stringify(selection)}`);
  }
  if (selection.selectedCount !== taskContext.evidenceRefs.length) {
    throw new Error(`Expected ${label} selectedCount to equal evidenceRefs length: ${JSON.stringify({ selection, evidenceRefs: taskContext.evidenceRefs })}`);
  }
  if (selection.selectedCount > selection.maxEvidenceRefs) {
    throw new Error(`Expected ${label} selected evidence to stay within maxEvidenceRefs: ${JSON.stringify(selection)}`);
  }
  const selectedKeys = selection.selectedRefs.map(evidenceKey);
  const evidenceKeys = taskContext.evidenceRefs.map(evidenceKey);
  if (selectedKeys.join('|') !== evidenceKeys.join('|')) {
    throw new Error(`Expected ${label} evidenceRefs to mirror selectedRefs: ${JSON.stringify({ selection, evidenceRefs: taskContext.evidenceRefs })}`);
  }
  if (!selection.selectedTypes.every((type) => taskContext.evidenceRefs.some((item) => item.type === type))) {
    throw new Error(`Expected ${label} selectedTypes to match selected refs: ${JSON.stringify(selection)}`);
  }
  if (selection.omittedRefs.length > selection.omittedCount) {
    throw new Error(`Expected ${label} omittedRefs to be a capped subset: ${JSON.stringify(selection)}`);
  }
}

function assertTaskMapCoversTypes(taskMap, requiredTypes, label) {
  const presentTypes = new Set((taskMap.items ?? []).map((item) => item.type));
  for (const type of requiredTypes) {
    if (!presentTypes.has(type)) {
      throw new Error(`Expected ${label} taskMap to include ${type}: ${JSON.stringify(taskMap.items)}`);
    }
  }
}

function assertTaskMapKeyMaterialFromEvidence(taskContext, evidenceTypes, label) {
  const evidenceTypeSet = new Set(evidenceTypes);
  const selectedMaterials = taskContext.evidenceSelection.selectedRefs.filter((ref) => evidenceTypeSet.has(ref.type));
  if (!selectedMaterials.length) {
    throw new Error(`Expected ${label} selected evidence to include key-material types: ${JSON.stringify(taskContext.evidenceSelection)}`);
  }
  const keyMaterialItems = taskContext.taskMap.items.filter((item) => item.type === 'key_material');
  const hasSelectedMaterial = selectedMaterials.some((ref) =>
    keyMaterialItems.some((item) => String(item.label).includes(`${ref.type}:`) && String(item.label).includes(ref.label))
  );
  if (!hasSelectedMaterial) {
    throw new Error(`Expected ${label} taskMap key_material to mirror selected evidence: ${JSON.stringify({ selectedMaterials, keyMaterialItems })}`);
  }
}

let serverHandle;
try {
  serverHandle = await startServer();
  const created = await api(serverHandle.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: '分析这个项目并给出实现计划，然后验证关键改动',
      tokenBudget: 30000,
      workspaceSnapshot: {
        rootName: 'demo-project',
        scannedAt: new Date().toISOString(),
        fileCount: 6,
        totalBytes: 768,
        tree: [
          { path: 'apps', kind: 'directory' },
          { path: 'apps/web/src/App.vue', kind: 'file' },
          { path: 'apps/web/src/App.test.ts', kind: 'file' },
          { path: 'tsconfig.json', kind: 'file' },
          { path: 'package.json', kind: 'file' }
        ],
        files: [
          { path: 'apps/web/src/App.vue', size: 128, language: 'vue', content: '<template><div>demo</div></template>' },
          { path: 'apps/web/src/App.test.ts', size: 96, language: 'typescript', content: 'import { describe, it } from "vitest"; describe("App", () => it("renders", () => {}));' },
          { path: 'tsconfig.json', size: 64, language: 'json', content: '{"compilerOptions":{"strict":true}}' },
          {
            path: 'package.json',
            size: 256,
            language: 'json',
            content: '{"name":"demo-project","scripts":{"typecheck":"tsc --noEmit","test":"vitest run","build":"vite build","test:e2e":"playwright test"}}'
          }
        ],
        skipped: [],
        detectedStack: ['vue', 'typescript'],
        entrypoints: ['apps/web/src/App.vue']
      }
    })
  });

  const sessionId = created.data.session.id;
  const detail = await api(serverHandle.apiBase, `/sessions/${sessionId}`);
  if (detail.data.taskDomain !== 'mixed') {
    throw new Error(`Expected mixed task domain, got ${detail.data.taskDomain}`);
  }
  if (detail.data.taskIntent !== 'validation') {
    throw new Error(`Expected validation task intent, got ${detail.data.taskIntent}`);
  }

  const briefId = await waitForBrief(serverHandle.apiBase, sessionId);
  const briefs = await api(serverHandle.apiBase, `/sessions/${sessionId}/briefs`);
  const brief = briefs.data[0];
  if (!brief) {
    throw new Error('Expected a brief to be created for mixed task flow');
  }
  await api(serverHandle.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });

  const events = await api(serverHandle.apiBase, `/sessions/${sessionId}/events`);
  const briefCreated = events.data.items.find((item) => item.type === 'brief_created');
  const suggestedTasks = briefCreated?.metadata?.payload?.suggestedTasks ?? [];
  const suggestedTitles = suggestedTasks.map((item) => item.title);
  if (!suggestedTitles.some((title) => String(title).includes('Plan mixed task'))) {
    throw new Error(`Expected mixed-task planning suggestion, got ${JSON.stringify(suggestedTitles)}`);
  }
  if (!suggestedTitles.some((title) => String(title).includes('Implement mixed task'))) {
    throw new Error(`Expected mixed-task implementation suggestion, got ${JSON.stringify(suggestedTitles)}`);
  }

  const taskExecutionPack = await waitForContextPack(
    serverHandle.apiBase,
    sessionId,
    (item) => item.phase === 'task_execution',
    'mixed task_execution'
  );
  if (!taskExecutionPack.contextPack.taskContext) {
    throw new Error('Expected taskContext in debug context pack');
  }
  if (!taskExecutionPack.contextPack.summaryMemory) {
    throw new Error('Expected summaryMemory in debug context pack');
  }
  if (taskExecutionPack.contextPack.taskContext.executionMode !== 'multi_agent') {
    throw new Error(`Expected multi_agent execution mode, got ${taskExecutionPack.contextPack.taskContext.executionMode}`);
  }
  assertContinuationStateShape(taskExecutionPack.contextPack, 'task_execution', 'mixed task execution');
  if (!taskExecutionPack.contextPack.continuationState.runningTaskIds.includes(taskExecutionPack.contextPack.currentTask.id)) {
    throw new Error(`Expected mixed continuation state to include active running task: ${JSON.stringify(taskExecutionPack.contextPack.continuationState)}`);
  }
  if (!taskExecutionPack.contextPack.continuationState.nextAgentKeys.includes('test')) {
    throw new Error(`Expected mixed continuation next agents to include test: ${JSON.stringify(taskExecutionPack.contextPack.continuationState)}`);
  }
  if (taskExecutionPack.contextPack.taskContext.currentStage !== 'task_execution') {
    throw new Error(`Expected task_execution currentStage, got ${taskExecutionPack.contextPack.taskContext.currentStage}`);
  }
  const mixedWorkspaceFocus = taskExecutionPack.contextPack.workspaceFocus;
  if (!mixedWorkspaceFocus) {
    throw new Error('Expected mixed task workspaceFocus');
  }
  if (!mixedWorkspaceFocus.impactedFiles?.includes('apps/web/src/App.vue')) {
    throw new Error(`Expected mixed workspaceFocus impactedFiles to include App.vue: ${JSON.stringify(mixedWorkspaceFocus)}`);
  }
  if (!mixedWorkspaceFocus.testFiles?.includes('apps/web/src/App.test.ts')) {
    throw new Error(`Expected mixed workspaceFocus testFiles to include App.test.ts: ${JSON.stringify(mixedWorkspaceFocus)}`);
  }
  if (!mixedWorkspaceFocus.configFiles?.includes('package.json') || !mixedWorkspaceFocus.configFiles?.includes('tsconfig.json')) {
    throw new Error(`Expected mixed workspaceFocus configFiles to include package.json and tsconfig.json: ${JSON.stringify(mixedWorkspaceFocus)}`);
  }
  for (const command of ['npm run typecheck', 'npm run test', 'npm run build']) {
    if (!mixedWorkspaceFocus.validationCommands?.includes(command)) {
      throw new Error(`Expected mixed workspaceFocus validationCommands to include ${command}: ${JSON.stringify(mixedWorkspaceFocus)}`);
    }
  }
  if (taskExecutionPack.contextPack.taskContext.taskMap.kind !== 'project_map') {
    throw new Error(`Expected project_map for mixed coding context, got ${taskExecutionPack.contextPack.taskContext.taskMap.kind}`);
  }
  assertEvidenceSelectionShape(taskExecutionPack.contextPack.taskContext, 'mixed_minimal', 'mixed task execution');
  assertTaskMapCoversTypes(
    taskExecutionPack.contextPack.taskContext.taskMap,
    ['module', 'boundary', 'entrypoint', 'key_material', 'validation_path'],
    'mixed Project Map'
  );
  assertTaskMapKeyMaterialFromEvidence(
    taskExecutionPack.contextPack.taskContext,
    ['artifact', 'diff', 'test', 'log', 'memory', 'external_reference', 'document_fragment'],
    'mixed Project Map'
  );
  if (!taskExecutionPack.contextPack.taskContext.evidenceSelection.selectedTypes.includes('workspace_file')) {
    throw new Error(`Expected mixed evidence selection to include workspace files: ${JSON.stringify(taskExecutionPack.contextPack.taskContext.evidenceSelection)}`);
  }
  if (!taskExecutionPack.contextPack.taskContext.evidenceSelection.selectedTypes.includes('workspace_symbol')) {
    throw new Error(`Expected mixed evidence selection to include workspace symbols: ${JSON.stringify(taskExecutionPack.contextPack.taskContext.evidenceSelection)}`);
  }
  if (!taskExecutionPack.contextPack.taskContext.evidenceSelection.selectedTypes.includes('diff')) {
    throw new Error(`Expected mixed evidence selection to include diff refs: ${JSON.stringify(taskExecutionPack.contextPack.taskContext.evidenceSelection)}`);
  }
  if (!taskExecutionPack.contextPack.taskContext.evidenceSelection.selectedTypes.includes('test')) {
    throw new Error(`Expected mixed evidence selection to include test refs: ${JSON.stringify(taskExecutionPack.contextPack.taskContext.evidenceSelection)}`);
  }
  if (!taskExecutionPack.contextPack.taskContext.taskMap.items.some((item) => item.type === 'key_material' && item.ref === 'package.json')) {
    throw new Error(`Expected mixed Project Map key material to include package.json: ${JSON.stringify(taskExecutionPack.contextPack.taskContext.taskMap.items)}`);
  }
  if (!taskExecutionPack.contextPack.taskContext.taskMap.items.some((item) => item.type === 'validation_path' && item.ref === 'apps/web/src/App.test.ts')) {
    throw new Error(`Expected mixed Project Map validation path to include App.test.ts: ${JSON.stringify(taskExecutionPack.contextPack.taskContext.taskMap.items)}`);
  }
  if (!taskExecutionPack.contextPack.taskContext.taskMap.items.some((item) => item.type === 'validation_path' && item.ref === 'npm run typecheck')) {
    throw new Error(`Expected mixed Project Map validation path to include npm run typecheck: ${JSON.stringify(taskExecutionPack.contextPack.taskContext.taskMap.items)}`);
  }
  assertStagePlanShape(taskExecutionPack.contextPack.taskContext.stagePlan, 'task_execution', 'mixed task execution');
  assertStagePlanCitesEvidence(
    taskExecutionPack.contextPack.taskContext.stagePlan,
    taskExecutionPack.contextPack.taskContext.evidenceRefs,
    ['workspace_snapshot', 'workspace_file', 'workspace_symbol', 'artifact'],
    'mixed task execution'
  );
  if (!taskExecutionPack.contextPack.taskContext.stagePlan.validate.some((item) => item.label === 'E2E or smoke flow')) {
    throw new Error(`Expected mixed stagePlan.validate to include smoke flow: ${JSON.stringify(taskExecutionPack.contextPack.taskContext.stagePlan)}`);
  }
  if (!taskExecutionPack.contextPack.taskContext.validationRules.some((rule) => rule.label === 'E2E or smoke flow')) {
    throw new Error(`Expected mixed validation rules to include smoke flow: ${JSON.stringify(taskExecutionPack.contextPack.taskContext.validationRules)}`);
  }
  if (!taskExecutionPack.contextPack.taskContext.agentResponsibilities.some((item) => item.role === 'validation')) {
    throw new Error('Expected validation agent responsibility in taskContext');
  }
  assertAgentResponsibilitiesIndependent(taskExecutionPack.contextPack.taskContext, 'mixed task execution');
  if (!taskExecutionPack.contextPack.summaryMemory.confirmedFacts.length) {
    throw new Error('Expected summaryMemory.confirmedFacts to be present');
  }
  if (!Array.isArray(taskExecutionPack.contextPack.summaryMemory.nextSteps)) {
    throw new Error('Expected summaryMemory.nextSteps to be present');
  }

  const invocations = await api(serverHandle.apiBase, `/sessions/${sessionId}/debug/runtime-invocations`);
  const invocation = invocations.data.items.find((item) => item.phase === 'task_execution');
  if (!invocation) {
    throw new Error('Expected runtime invocation summary for task_execution');
  }
  if (invocation.contextPackSummary.eventCount < 1) {
    throw new Error('Expected invocation summary to include event counts');
  }
  if (invocation.contextPackSummary.taskMapKind !== 'project_map') {
    throw new Error(`Expected invocation summary project_map, got ${invocation.contextPackSummary.taskMapKind}`);
  }
  if (invocation.contextPackSummary.validationRuleCount < 1) {
    throw new Error('Expected invocation summary to include validation rule count');
  }
  if (invocation.contextPackSummary.evidenceSelectionStrategy !== 'mixed_minimal') {
    throw new Error(`Expected invocation summary evidence selection strategy mixed_minimal, got ${invocation.contextPackSummary.evidenceSelectionStrategy}`);
  }
  if (invocation.contextPackSummary.evidenceSelectionSelectedCount !== invocation.contextPackSummary.evidenceCount) {
    throw new Error(`Expected invocation summary selected evidence count to match evidenceCount: ${JSON.stringify(invocation.contextPackSummary)}`);
  }
  if (invocation.contextPackSummary.continuationPhase !== 'task_execution') {
    throw new Error(`Expected invocation summary continuation phase task_execution, got ${invocation.contextPackSummary.continuationPhase}`);
  }
  if (invocation.contextPackSummary.continuationResumeHintCount < 1) {
    throw new Error('Expected invocation summary to include continuation resume hints');
  }

  const mixedValidation = await waitForValidationEvidenceArtifact(serverHandle.apiBase, sessionId, 'mixed validation evidence');
  if (mixedValidation.artifact.type !== 'test_report') {
    throw new Error(`Expected mixed validation artifact to be test_report, got ${mixedValidation.artifact.type}`);
  }
  if (mixedValidation.validationEvidence.domain !== 'mixed') {
    throw new Error(`Expected mixed validation evidence domain, got ${mixedValidation.validationEvidence.domain}`);
  }
  if (!mixedValidation.validationEvidence.verdicts.some((verdict) => verdict.ruleLabel === 'E2E or smoke flow')) {
    throw new Error(`Expected mixed validation verdicts to include smoke flow: ${JSON.stringify(mixedValidation.validationEvidence.verdicts)}`);
  }
  if (!mixedValidation.validationEvidence.verdicts.every((verdict) => Array.isArray(verdict.evidenceRefs) && verdict.evidenceRefs.length > 0)) {
    throw new Error(`Expected every mixed validation verdict to cite evidence refs: ${JSON.stringify(mixedValidation.validationEvidence.verdicts)}`);
  }
  const mixedValidationPack = await waitForContextPack(
    serverHandle.apiBase,
    sessionId,
    (item) => item.phase === 'task_execution' && item.agentKey === 'test' && item.contextPack.taskContext?.domain === 'mixed',
    'mixed validation task context'
  );
  if (!mixedValidationPack.contextPack.summaryMemory.checkpointRefs?.length) {
    throw new Error(`Expected mixed validation context to inherit summary checkpoint refs: ${JSON.stringify(mixedValidationPack.contextPack.summaryMemory)}`);
  }
  if (!mixedValidationPack.contextPack.summaryMemory.sourceArtifactIds?.length) {
    throw new Error(`Expected mixed validation context to cite source artifacts: ${JSON.stringify(mixedValidationPack.contextPack.summaryMemory)}`);
  }
  assertContinuationStateShape(mixedValidationPack.contextPack, 'task_execution', 'mixed validation task context');
  if (!mixedValidationPack.contextPack.continuationState.completedTaskIds.length) {
    throw new Error(`Expected mixed validation context to see completed prior tasks: ${JSON.stringify(mixedValidationPack.contextPack.continuationState)}`);
  }
  if (!mixedValidationPack.contextPack.continuationState.lastCheckpointRef) {
    throw new Error(`Expected mixed validation context to carry latest checkpoint ref: ${JSON.stringify(mixedValidationPack.contextPack.continuationState)}`);
  }
  assertEvidenceSelectionShape(mixedValidationPack.contextPack.taskContext, 'mixed_minimal', 'mixed validation task context');
  assertValidationEvidenceIndependence(
    mixedValidation.validationEvidence,
    mixedValidationPack.contextPack.taskContext,
    'mixed validation evidence'
  );
  const mixedSummaryCheckpoints = await waitForSummaryMemoryCheckpoints(serverHandle.apiBase, sessionId, 3, 'mixed task checkpoints');
  const mixedCheckpointPhases = mixedSummaryCheckpoints.items.map((item) => item.checkpoint.phase);
  if (!mixedCheckpointPhases.includes('brief_generation') || !mixedCheckpointPhases.includes('task_execution')) {
    throw new Error(`Expected mixed summary checkpoints across brief and execution phases: ${JSON.stringify(mixedCheckpointPhases)}`);
  }
  if (!mixedSummaryCheckpoints.latest?.checkpoint?.summaryMemory?.sourceMemoryIds?.length) {
    throw new Error(`Expected latest mixed summary checkpoint to reference a memory item: ${JSON.stringify(mixedSummaryCheckpoints.latest)}`);
  }

  const docWorkspace = await api(serverHandle.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: '分析会议记录并输出文档协作方案',
      tokenBudget: 30000,
      workspaceSnapshot: {
        rootName: 'docs-only-workspace',
        scannedAt: new Date().toISOString(),
        fileCount: 1,
        totalBytes: 256,
        tree: [{ path: 'README.md', kind: 'file' }],
        files: [
          {
            path: 'README.md',
            size: 256,
            language: 'markdown',
            content: '# Meeting Notes\n\nScope, risks, evidence, and delivery checklist.'
          }
        ],
        skipped: [],
        detectedStack: ['markdown'],
        entrypoints: ['README.md']
      }
    })
  });
  const docWorkspaceSessionId = docWorkspace.data.session.id;
  const docWorkspaceDetail = await api(serverHandle.apiBase, `/sessions/${docWorkspaceSessionId}`);
  if (docWorkspaceDetail.data.taskDomain !== 'non_coding') {
    throw new Error(`Expected markdown-only workspace to remain non_coding, got ${docWorkspaceDetail.data.taskDomain}`);
  }
  const docWorkspacePack = await waitForContextPack(
    serverHandle.apiBase,
    docWorkspaceSessionId,
    (item) => item.phase === 'brief_generation' && item.contextPack.taskContext?.domain === 'non_coding',
    'markdown-only non-coding brief_generation'
  );
  if (docWorkspacePack.contextPack.taskContext.taskMap.kind !== 'domain_map') {
    throw new Error(`Expected markdown-only non-coding workspace to use Domain Map, got ${docWorkspacePack.contextPack.taskContext.taskMap.kind}`);
  }

  const knowledgeBase = await api(serverHandle.apiBase, '/knowledge-bases', {
    method: 'POST',
    body: JSON.stringify({
      name: 'meeting-analysis-evidence',
      scope: 'session'
    })
  });
  await api(serverHandle.apiBase, `/knowledge-bases/${knowledgeBase.data.id}/documents`, {
    method: 'POST',
    body: JSON.stringify({
      title: 'meeting notes for方案建议',
      sourceType: 'text',
      content:
        'validate analysis 调研会议记录并整理一份方案建议 输出风险和下一步。会议记录强调范围一致性、事实来源、结论可追溯和交付完整性。'
    })
  });

  for (const document of [
    {
      title: 'meeting-note evidence for analysis',
      sourceType: 'meeting_note',
      content:
        'analyze request validate analysis meeting_note evidence: scope consistency, fact source, traceability, delivery completeness, risks, next steps.'
    },
    {
      title: 'data-table evidence for analysis',
      sourceType: 'data_table',
      content:
        'analyze request validate analysis data_table evidence: decision matrix, risk rows, scope columns, completeness metrics, next steps.'
    },
    {
      title: 'external reference evidence for analysis',
      sourceType: 'external_reference',
      sourceUri: 'https://example.invalid/non-coding-evidence',
      content:
        'analyze request validate analysis external_reference evidence: external source, traceability support, risk benchmark, delivery checklist.'
    }
  ]) {
    await api(serverHandle.apiBase, `/knowledge-bases/${knowledgeBase.data.id}/documents`, {
      method: 'POST',
      body: JSON.stringify(document)
    });
  }

  const nonCoding = await api(serverHandle.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: '调研会议记录并整理一份方案建议，输出风险和下一步',
      tokenBudget: 30000,
      knowledgeBaseIds: [knowledgeBase.data.id]
    })
  });
  const nonCodingSessionId = nonCoding.data.session.id;
  const nonCodingDetail = await api(serverHandle.apiBase, `/sessions/${nonCodingSessionId}`);
  if (nonCodingDetail.data.taskDomain !== 'non_coding') {
    throw new Error(`Expected non_coding task domain, got ${nonCodingDetail.data.taskDomain}`);
  }
  if (nonCodingDetail.data.taskIntent !== 'analysis') {
    throw new Error(`Expected analysis task intent, got ${nonCodingDetail.data.taskIntent}`);
  }
  const nonCodingBriefId = await waitForBrief(serverHandle.apiBase, nonCodingSessionId);
  await api(serverHandle.apiBase, `/sessions/${nonCodingSessionId}/memories`, {
    method: 'POST',
    body: JSON.stringify({
      content: 'Analyze request 调研会议记录并整理一份方案建议 输出风险和下一步：需要保留事实来源、范围边界、风险和下一步。',
      scope: 'session',
      confidence: 0.91
    })
  });
  await api(serverHandle.apiBase, `/sessions/${nonCodingSessionId}/briefs/${nonCodingBriefId}/confirm`, { method: 'POST' });
  const nonCodingEvents = await api(serverHandle.apiBase, `/sessions/${nonCodingSessionId}/events`);
  const nonCodingBriefCreated = nonCodingEvents.data.items.find((item) => item.type === 'brief_created');
  const nonCodingSuggestedTasks = nonCodingBriefCreated?.metadata?.payload?.suggestedTasks ?? [];
  if (!nonCodingSuggestedTasks.some((task) => task.suggestedAgentKey === 'test')) {
    throw new Error(`Expected non-coding validation task assigned to test agent: ${JSON.stringify(nonCodingSuggestedTasks)}`);
  }
  const nonCodingPack = await waitForContextPack(
    serverHandle.apiBase,
    nonCodingSessionId,
    (item) => item.phase === 'task_execution' && item.contextPack.taskContext?.domain === 'non_coding',
    'non-coding task_execution'
  );
  if (nonCodingPack.contextPack.taskContext.taskMap.kind !== 'domain_map') {
    throw new Error(`Expected domain_map for non-coding context, got ${nonCodingPack.contextPack.taskContext.taskMap.kind}`);
  }
  const nonCodingMapItems = nonCodingPack.contextPack.taskContext.taskMap.items;
  if (!nonCodingMapItems.some((item) => item.type === 'entrypoint')) {
    throw new Error(`Expected non-coding Domain Map to include an entrypoint: ${JSON.stringify(nonCodingMapItems)}`);
  }
  if (!nonCodingMapItems.some((item) => item.type === 'key_material' && String(item.label).includes('document_fragment'))) {
    throw new Error(`Expected non-coding Domain Map to include document key material: ${JSON.stringify(nonCodingMapItems)}`);
  }
  if (!nonCodingMapItems.some((item) => item.type === 'key_material' && String(item.label).includes('memory'))) {
    throw new Error(`Expected non-coding Domain Map to include memory key material: ${JSON.stringify(nonCodingMapItems)}`);
  }
  assertEvidenceSelectionShape(nonCodingPack.contextPack.taskContext, 'non_coding_minimal', 'non-coding task execution');
  if (!nonCodingPack.contextPack.taskContext.evidenceSelection.selectedTypes.includes('document_fragment')) {
    throw new Error(`Expected non-coding evidence selection to include document fragments: ${JSON.stringify(nonCodingPack.contextPack.taskContext.evidenceSelection)}`);
  }
  if (!nonCodingPack.contextPack.taskContext.evidenceSelection.selectedTypes.includes('memory')) {
    throw new Error(`Expected non-coding evidence selection to include memory: ${JSON.stringify(nonCodingPack.contextPack.taskContext.evidenceSelection)}`);
  }
  for (const type of ['meeting_note', 'data_table', 'external_reference', 'historical_decision']) {
    if (!nonCodingPack.contextPack.taskContext.evidenceSelection.selectedTypes.includes(type)) {
      throw new Error(`Expected non-coding evidence selection to include ${type}: ${JSON.stringify(nonCodingPack.contextPack.taskContext.evidenceSelection)}`);
    }
  }
  assertContinuationStateShape(nonCodingPack.contextPack, 'task_execution', 'non-coding task execution');
  if (!nonCodingPack.contextPack.continuationState.nextAgentKeys.includes('test')) {
    throw new Error(`Expected non-coding continuation next agents to include test: ${JSON.stringify(nonCodingPack.contextPack.continuationState)}`);
  }
  assertAgentResponsibilitiesIndependent(nonCodingPack.contextPack.taskContext, 'non-coding task execution');
  assertStagePlanShape(nonCodingPack.contextPack.taskContext.stagePlan, 'task_execution', 'non-coding task execution');
  assertStagePlanCitesEvidence(
    nonCodingPack.contextPack.taskContext.stagePlan,
    nonCodingPack.contextPack.taskContext.evidenceRefs,
    ['document_fragment', 'meeting_note', 'data_table', 'external_reference', 'memory', 'historical_decision', 'user_input'],
    'non-coding task execution'
  );
  for (const label of ['Fact consistency', 'Traceability']) {
    if (!nonCodingPack.contextPack.taskContext.stagePlan.validate.some((item) => item.label === label)) {
      throw new Error(`Expected non-coding stagePlan.validate to include ${label}: ${JSON.stringify(nonCodingPack.contextPack.taskContext.stagePlan)}`);
    }
  }
  if (!nonCodingPack.contextPack.taskContext.validationRules.some((rule) => rule.label === 'Fact consistency')) {
    throw new Error(`Expected non-coding validation rules: ${JSON.stringify(nonCodingPack.contextPack.taskContext.validationRules)}`);
  }
  const nonCodingEvidenceTypes = nonCodingPack.contextPack.taskContext.evidenceRefs.map((item) => item.type);
  if (!nonCodingEvidenceTypes.includes('document_fragment')) {
    throw new Error(`Expected non-coding evidence refs to include RAG document fragments: ${JSON.stringify(nonCodingPack.contextPack.taskContext.evidenceRefs)}`);
  }
  if (!nonCodingEvidenceTypes.includes('memory')) {
    throw new Error(`Expected non-coding evidence refs to include memory hits: ${JSON.stringify(nonCodingPack.contextPack.taskContext.evidenceRefs)}`);
  }
  for (const type of ['meeting_note', 'data_table', 'external_reference', 'historical_decision']) {
    if (!nonCodingEvidenceTypes.includes(type)) {
      throw new Error(`Expected non-coding evidence refs to include ${type}: ${JSON.stringify(nonCodingPack.contextPack.taskContext.evidenceRefs)}`);
    }
  }

  const nonCodingValidation = await waitForValidationEvidenceArtifact(
    serverHandle.apiBase,
    nonCodingSessionId,
    'non-coding validation evidence'
  );
  if (nonCodingValidation.artifact.type !== 'test_report') {
    throw new Error(`Expected non-coding validation artifact to be test_report, got ${nonCodingValidation.artifact.type}`);
  }
  if (nonCodingValidation.validationEvidence.domain !== 'non_coding') {
    throw new Error(`Expected non-coding validation evidence domain, got ${nonCodingValidation.validationEvidence.domain}`);
  }
  const nonCodingVerdictLabels = nonCodingValidation.validationEvidence.verdicts.map((verdict) => verdict.ruleLabel);
  for (const label of ['Fact consistency', 'Scope consistency', 'Traceability', 'Delivery completeness']) {
    if (!nonCodingVerdictLabels.includes(label)) {
      throw new Error(`Expected non-coding validation verdict for ${label}: ${JSON.stringify(nonCodingValidation.validationEvidence.verdicts)}`);
    }
  }
  if (!nonCodingValidation.validationEvidence.verdicts.every((verdict) => Array.isArray(verdict.evidenceRefs) && verdict.evidenceRefs.length > 0)) {
    throw new Error(`Expected every non-coding validation verdict to cite evidence refs: ${JSON.stringify(nonCodingValidation.validationEvidence.verdicts)}`);
  }
  const validationEvidenceTypes = nonCodingValidation.validationEvidence.evidenceRefs.map((item) => item.type);
  for (const type of ['document_fragment', 'meeting_note', 'data_table', 'external_reference', 'memory']) {
    if (!validationEvidenceTypes.includes(type)) {
      throw new Error(`Expected validation evidence to preserve ${type} refs: ${JSON.stringify(nonCodingValidation.validationEvidence.evidenceRefs)}`);
    }
  }
  if (!validationEvidenceTypes.includes('document_fragment') || !validationEvidenceTypes.includes('memory')) {
    throw new Error(`Expected validation evidence to preserve document and memory refs: ${JSON.stringify(nonCodingValidation.validationEvidence.evidenceRefs)}`);
  }
  const nonCodingValidationPack = await waitForContextPack(
    serverHandle.apiBase,
    nonCodingSessionId,
    (item) => item.phase === 'task_execution' && item.agentKey === 'test' && item.contextPack.taskContext?.domain === 'non_coding',
    'non-coding validation task context'
  );
  if (!nonCodingValidationPack.contextPack.summaryMemory.checkpointRefs?.length) {
    throw new Error(`Expected non-coding validation context to inherit summary checkpoint refs: ${JSON.stringify(nonCodingValidationPack.contextPack.summaryMemory)}`);
  }
  if (!nonCodingValidationPack.contextPack.summaryMemory.sourceMemoryIds?.length) {
    throw new Error(`Expected non-coding validation context to cite source memories: ${JSON.stringify(nonCodingValidationPack.contextPack.summaryMemory)}`);
  }
  assertContinuationStateShape(nonCodingValidationPack.contextPack, 'task_execution', 'non-coding validation task context');
  if (!nonCodingValidationPack.contextPack.continuationState.completedTaskIds.length) {
    throw new Error(`Expected non-coding validation context to see completed prior tasks: ${JSON.stringify(nonCodingValidationPack.contextPack.continuationState)}`);
  }
  if (!nonCodingValidationPack.contextPack.continuationState.lastCheckpointRef) {
    throw new Error(`Expected non-coding validation context to carry latest checkpoint ref: ${JSON.stringify(nonCodingValidationPack.contextPack.continuationState)}`);
  }
  assertEvidenceSelectionShape(nonCodingValidationPack.contextPack.taskContext, 'non_coding_minimal', 'non-coding validation task context');
  assertValidationEvidenceIndependence(
    nonCodingValidation.validationEvidence,
    nonCodingValidationPack.contextPack.taskContext,
    'non-coding validation evidence'
  );
  const nonCodingSummaryCheckpoints = await waitForSummaryMemoryCheckpoints(
    serverHandle.apiBase,
    nonCodingSessionId,
    3,
    'non-coding task checkpoints'
  );
  if (!nonCodingSummaryCheckpoints.items.every((item) => item.checkpoint.kind === 'summary_memory_checkpoint')) {
    throw new Error(`Expected structured summary memory checkpoints: ${JSON.stringify(nonCodingSummaryCheckpoints.items)}`);
  }
  if (!nonCodingSummaryCheckpoints.latest?.checkpoint?.summaryMemory?.sourceEventIds?.length) {
    throw new Error(`Expected latest non-coding summary checkpoint to reference source events: ${JSON.stringify(nonCodingSummaryCheckpoints.latest)}`);
  }

  console.log('unified task context smoke ok');
} finally {
  if (serverHandle) {
    await stopServer(serverHandle.server);
  }
}
