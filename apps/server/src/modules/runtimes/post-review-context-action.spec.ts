import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRunInput } from '@agent-cluster/shared';
import { ClaudeCodeRuntimeAdapterService } from './claude-code-runtime-adapter.service.js';
import { CodexRuntimeAdapterService } from './codex-runtime-adapter.service.js';
import { GenericLlmRuntimeService } from './generic-llm-runtime.service.js';
import { MockRuntimeService } from './mock-runtime.service.js';

function postReviewInput(): AgentRunInput {
  return {
    runId: 'run-post-review-context',
    sessionId: 'session-post-review-context',
    phase: 'post_review',
    agent: {
      id: 'review',
      key: 'review',
      name: 'Review Agent',
      role: 'review',
      systemPrompt: 'Review outputs against available evidence.',
      runtimeType: 'generic_llm',
      capabilityIds: []
    },
    contextPack: {
      sessionGoal: 'Review an evidence-sensitive implementation.',
      taskContext: {
        domain: 'coding',
        intent: 'review',
        currentStage: 'post_review',
        evidenceRefs: [{ type: 'workspace_file', label: 'Feature source', ref: 'src/feature.ts' }]
      },
      workspaceFocus: {
        relevantFiles: ['src/feature.ts'],
        impactedFiles: [],
        testFiles: [],
        configFiles: [],
        possibleEntryPoints: [],
        detectedStack: ['typescript'],
        validationCommands: [],
        rationale: 'Review needs the feature source.'
      },
      relevantEvents: [],
      relevantMemories: [],
      ragSnippets: [],
      artifacts: [],
      capabilities: [],
      constraints: [],
      budget: { maxOutputTokens: 500 }
    },
    expectedOutput: { kind: 'post_review_report', schemaVersion: '0.1' },
    budget: { maxOutputTokens: 500 },
    options: { allowMockFallback: true, scenario: 'post_review_context_insufficient' }
  } as unknown as AgentRunInput;
}

test('Post Review prompts require a traceable workspace-context action when evidence is missing', () => {
  const input = postReviewInput();
  const generic = new GenericLlmRuntimeService({} as never, {} as never, {} as never) as unknown as {
    buildRemoteSystemPrompt(input: AgentRunInput): string;
    buildLocalSystemPrompt(input: AgentRunInput): string;
  };
  const codex = new CodexRuntimeAdapterService() as unknown as {
    prompt(input: AgentRunInput): string;
  };
  const claude = new ClaudeCodeRuntimeAdapterService() as unknown as {
    prompt(input: AgentRunInput): string;
  };

  for (const prompt of [
    generic.buildRemoteSystemPrompt(input),
    generic.buildLocalSystemPrompt(input),
    codex.prompt(input),
    claude.prompt(input)
  ]) {
    assert.match(prompt, /request_workspace_context/);
    assert.match(prompt, /missingPaths/);
  }
});

test('Mock Post Review evidence-gap scenario emits the missing workspace paths', async () => {
  const result = await new MockRuntimeService().run(postReviewInput());

  assert.equal(result.status, 'completed');
  assert.equal(result.output.kind, 'post_review_report');
  if (result.output.kind !== 'post_review_report') return;
  assert.equal(result.output.recommendation, 'ask_user');
  assert.deepEqual(result.output.actions, [
    {
      action: 'request_workspace_context',
      reason: 'Post Review needs additional workspace evidence before it can verify completion.',
      missingPaths: ['src/feature.ts']
    }
  ]);
});
