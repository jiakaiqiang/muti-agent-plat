import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

function read(path) {
  return readFileSync(`${root}/${path}`, 'utf8');
}

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`${label} must include ${needle}`);
  }
}

function assertNotIncludes(source, needle, label) {
  if (source.includes(needle)) {
    throw new Error(`${label} must not hard-truncate key visibility with ${needle}`);
  }
}

const graph = read('apps/web/src/components/CollaborationGraphView.vue');
const workflow = read('apps/web/src/components/WorkflowRuntimeView.vue');

for (const phase of [
  'task_claim_decision',
  'task_claim_declined',
  'task_acceptance',
  'user_message_routing',
  'agent_runtime_communication'
]) {
  assertIncludes(graph, phase, 'Collaboration graph');
}

assertIncludes(graph, 'pinnedPhases', 'Collaboration graph');
assertIncludes(graph, 'allCommunicationEdges', 'Collaboration graph');
assertIncludes(graph, 'phaseCounts', 'Collaboration graph');
assertIncludes(graph, 'startNodeDrag', 'Collaboration graph draggable agents');
assertIncludes(graph, 'startEdgeDrag', 'Collaboration graph adjustable edges');
assertIncludes(graph, 'startEdgeLineDrag', 'Collaboration graph draggable edge body');
assertIncludes(graph, 'edge-drag-handle', 'Collaboration graph edge handles');
assertIncludes(graph, 'taskDerivedEdges', 'Collaboration graph task-derived links');
assertIncludes(graph, 'graph-view-switcher', 'Collaboration graph in-view mode switcher');
assertIncludes(graph, "switchView', mode.mode", 'Collaboration graph view switch handler');
assertNotIncludes(graph, '.slice(0, 8)', 'Collaboration graph real agent sync');
assertNotIncludes(graph, '.slice(-8)', 'Collaboration graph');

for (const signal of ['接单', '拒单转派', '补充路由', 'Agent 通信', '文件变更', '最终交付']) {
  assertIncludes(workflow, signal, 'Workflow signal strip');
}

assertIncludes(workflow, 'workflowKeySignals', 'Workflow view');
assertIncludes(workflow, 'workflowEventMeta', 'Workflow view');
assertIncludes(workflow, 'file changes', 'Workflow event metadata');
assertIncludes(workflow, 'startWorkflowNodeDrag', 'Workflow draggable agents');
assertIncludes(workflow, 'startWorkflowEdgeDrag', 'Workflow adjustable edges');
assertIncludes(workflow, 'startWorkflowEdgeLineDrag', 'Workflow draggable edge body');
assertIncludes(workflow, 'edge-drag-handle', 'Workflow edge handles');
assertIncludes(workflow, 'workflow-mode-switcher', 'Workflow in-view mode switcher');
assertIncludes(workflow, "switchView', mode.mode", 'Workflow view switch handler');
assertNotIncludes(workflow, '.slice(0, 8)', 'Workflow real agent sync');
assertNotIncludes(workflow, '.slice(-6)', 'Workflow view');

const workspace = read('apps/web/src/components/SessionWorkspace.vue');
const timeline = read('apps/web/src/components/ChatTimeline.vue');
const styles = read('apps/web/src/styles.css');
for (const mode of ['chat', 'workflow', 'collaboration_graph', 'debug']) {
  assertIncludes(workspace, mode, 'Workspace view mode switcher');
}
assertIncludes(workspace, 'v-for="mode in viewModes"', 'Workspace view mode switcher');
assertIncludes(workspace, ':current-mode="currentMode"', 'Workspace passes current mode to graph views');
assertIncludes(workspace, '@switch-view="sessionStore.switchViewMode"', 'Workspace handles graph view switching');
assertNotIncludes(styles, '.mode-workflow .workspace-header {\n  display: none;', 'Workflow view mode switcher');
assertIncludes(styles, 'graph-view-switcher', 'Graph view switcher styles');
assertIncludes(styles, 'scrollbar-color', 'Themed scrollbar styles');

for (const signal of [
  'requestedContextPayload',
  'requestedContextRefs',
  'requestedContextPaths',
  'requestedContextCommands',
  'context-request-block',
  'Requested refs',
  'Requested paths',
  'Requested commands'
]) {
  assertIncludes(timeline, signal, 'Chat timeline context request visibility');
}
assertIncludes(styles, 'context-request-block', 'Context request block styles');
assertIncludes(styles, 'context-request-list', 'Context request list styles');

console.log('ui collaboration visibility smoke ok');
