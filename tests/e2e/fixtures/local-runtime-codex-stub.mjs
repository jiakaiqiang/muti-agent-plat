import { mkdirSync, writeFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';

if (process.argv.includes('--version')) {
  stdout.write('local-runtime-codex-stub 1.0.0\n');
  process.exit(0);
}

let prompt = '';
stdin.setEncoding('utf8');
stdin.on('data', (chunk) => { prompt += chunk; });
stdin.on('end', () => {
  const kind = prompt.match(/Required output kind:\s*([a-z_]+)/)?.[1] ?? 'agent_message';
  if (kind === 'task_execution_result') {
    mkdirSync('src', { recursive: true });
    writeFileSync('src/local-runtime-e2e.txt', 'written through local Runtime ChangeSet\n');
  }
  stdout.write(`${JSON.stringify(outputFor(kind))}\n`);
});

function outputFor(kind) {
  switch (kind) {
    case 'task_brief':
      return {
        schemaVersion: '1.0',
        kind,
        goal: 'Write a file through the Local Runtime CLI.',
        scope: ['Create the requested local workspace file.'],
        outOfScope: [],
        constraints: ['Operate only in the authorized local workspace.'],
        acceptanceCriteria: ['src/local-runtime-e2e.txt exists in the authorized workspace.'],
        risks: [],
        openQuestions: [],
        suggestedTasks: [{
          title: 'Write the Local Runtime E2E file',
          description: 'Create src/local-runtime-e2e.txt through the Local Runtime ChangeSet flow.',
          suggestedAgentKey: 'backend',
          routingMode: 'coordinator_controlled',
          assignmentReason: 'The backend agent owns the fixture implementation.',
          contextRequirements: [],
          verificationPlan: ['Read the resulting file from the authorized workspace.'],
          riskNotes: [],
          requiresUserConfirmation: false,
          dependsOnTaskTitles: [],
          acceptanceCriteria: ['The file is applied by ChangeSet.']
        }]
      };
    case 'task_acceptance_decision':
      return {
        schemaVersion: '1.0',
        kind,
        status: 'accepted',
        reason: 'The fixture can execute this task in the authorized workspace.',
        missingContext: [],
        requestedContext: null,
        handoffSuggestion: null,
        confidence: 1,
        alternativeAgentKeys: [],
        alternativeAgentIds: [],
        agentMessages: []
      };
    case 'task_execution_result':
      return {
        schemaVersion: '1.0',
        kind,
        status: 'completed',
        summary: 'The Local Runtime fixture wrote the requested file.',
        completedItems: ['Created src/local-runtime-e2e.txt in the isolated invocation directory.'],
        changedArtifacts: [],
        requestedContext: null,
        agentMessages: [],
        nextSuggestedActions: [],
        risks: []
      };
    case 'post_review_report':
      return {
        schemaVersion: '1.0',
        kind,
        isConsistentWithBrief: true,
        matchedItems: ['The requested file was created.'],
        mismatchedItems: [],
        missingItems: [],
        outOfScopeChanges: [],
        testResults: [],
        recommendation: 'deliver',
        actions: []
      };
    case 'final_delivery':
      return {
        schemaVersion: '1.0',
        kind,
        summary: 'Local Runtime E2E delivery completed.',
        completedItems: ['Applied the local workspace ChangeSet.'],
        incompleteItems: [],
        risks: [],
        artifactRefs: []
      };
    case 'user_message_handling_plan':
      return {
        schemaVersion: '1.0',
        kind,
        intent: 'constraint',
        priority: 'normal',
        shouldPause: false,
        affectedTaskIds: [],
        affectedAgentIds: [],
        requiresBriefRevision: false,
        requiresUserConfirmation: false,
        coordinatorInstruction: 'Continue the fixture invocation.'
      };
    case 'agent_message':
    default:
      return {
        schemaVersion: '1.0',
        kind: 'agent_message',
        messageKind: 'discussion',
        content: 'The Local Runtime fixture is ready.',
        targetAgentIds: [],
        targetAgentKeys: [],
        mentionedAgentIds: [],
        relatedTaskIds: []
      };
  }
}
