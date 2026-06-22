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
const taskBoard = read('apps/web/src/components/CollaborationTaskBoard.vue');
const debugView = read('apps/web/src/components/DebugRuntimeView.vue');
const styles = read('apps/web/src/styles.css');
const designIndex = read('docs/design/README.md');
const collaborationTarget = read('docs/design/agent-collaboration-target-design-v1.md');
const contextRouterTarget = read('docs/design/context-router-target-design-v1.md');
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

assertIncludes(workspace, "debug: '审计'", 'Workspace labels debug as audit support');
assertIncludes(workspace, '审计事件流', 'Workspace log labels audit as support view');
assertIncludes(debugView, '上下文审计台', 'Debug view is positioned as audit');
assertIncludes(debugView, '不替代群聊协作主流程', 'Debug view does not replace collaboration mainline');
assertIncludes(debugView, 'Workspace Manifest', 'Debug view exposes workspace manifest as audit data');
assertIncludes(debugView, 'Selected Evidence Contents', 'Debug view exposes selected injected content as audit data');
assertIncludes(designIndex, 'agent-collaboration-target-design-v1.md', 'Design index collaboration target');
assertIncludes(collaborationTarget, 'Context governance is a supporting capability', 'Collaboration target positions context governance');
assertIncludes(contextRouterTarget, 'Context Router 不是 Agent Cluster 的产品主角', 'Context router support positioning');

assertIncludes(workspace, '<CollaborationTaskBoard', 'Chat mainline includes collaboration task board');
assertIncludes(taskBoard, 'Task Brief', 'Task board surfaces task brief');
assertIncludes(taskBoard, 'Task Decomposition', 'Task board surfaces task decomposition');
assertIncludes(taskBoard, 'Discussion Evidence', 'Task board surfaces group-chat discussion evidence');
assertIncludes(taskBoard, 'discussionAgentCount', 'Task board counts discussion participants');
assertIncludes(taskBoard, 'discussionRoundCount', 'Task board counts discussion rounds');
assertIncludes(taskBoard, 'decisionEvents', 'Task board surfaces decisions, risks, handoffs, and summaries');
assertIncludes(taskBoard, 'suggestedTasks', 'Task board surfaces suggested tasks before confirmation');
assertIncludes(taskBoard, 'Proposed', 'Task board labels pre-confirmation suggested tasks');
assertIncludes(taskBoard, 'dependsOnTaskTitles', 'Task board surfaces suggested task dependencies');
assertIncludes(taskBoard, 'Review & Delivery', 'Task board surfaces review and delivery');
assertIncludes(taskBoard, 'acceptanceCoverage', 'Task board links delivery back to acceptance coverage');
assertIncludes(taskBoard, 'validationItems', 'Task board surfaces validation evidence');
assertIncludes(taskBoard, 'deliveryEvidence', 'Task board surfaces artifact-backed delivery evidence');
assertIncludes(taskBoard, 'remainingRisks', 'Task board surfaces incomplete items and risks');
assertIncludes(taskBoard, 'Delivery Evidence', 'Task board labels delivery evidence for the user');
assertIncludes(taskBoard, 'Needs Attention', 'Task board labels remaining risks for the user');
assertIncludes(taskBoard, 'activeConfirmation?.relatedBriefId', 'Task board surfaces user confirmation gate');
assertIncludes(taskBoard, '<ConfirmationCard', 'Task board renders the brief confirmation card inline');
assertIncludes(taskBoard, "emit('resolveConfirmation'", 'Task board emits confirmation decisions');
assertIncludes(workspace, '@resolve-confirmation="resolveConfirmation"', 'Workspace handles task board confirmation decisions');
assertIncludes(taskBoard, 'context_supplement', 'Task board surfaces supplemental context events');

console.log('ui collaboration visibility smoke ok');
