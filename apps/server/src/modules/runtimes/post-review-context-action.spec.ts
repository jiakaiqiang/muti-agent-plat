import assert from 'node:assert/strict';
import test from 'node:test';
import type { InvocationPlan } from '@agent-cluster/shared';
import { ClaudeCodeRuntimeAdapterService } from './claude-code-runtime-adapter.service.js';
import { CodexRuntimeAdapterService } from './codex-runtime-adapter.service.js';
import { GenericLlmRuntimeService } from './generic-llm-runtime.service.js';
import { makeInvocationPlan } from './invocation-plan.fixture.js';

function postReviewPlan(): InvocationPlan {
  return makeInvocationPlan({
    invocationId: 'run-post-review-context',
    sessionId: 'session-post-review-context',
    phase: 'post_review',
    agent: {
      agentId: 'review',
      key: 'review',
      name: 'Review Agent',
      role: 'review',
      systemPrompt: 'Review outputs against available evidence.'
    },
    executionTarget: { runtimeType: 'generic_llm' },
    contextEnvelope: {
      L1: {
        sessionGoal: 'Review an evidence-sensitive implementation.',
        phase: 'post_review',
        navigation: {
          entries: [{ path: 'src/feature.ts', kind: 'file', generated: false, sensitive: false }]
        }
      }
    },
    expectedOutput: { kind: 'post_review_report', schemaVersion: '1.0' },
    budget: { maxOutputTokens: 500 }
  });
}

function prompts(plan: InvocationPlan) {
  const bindings = { resolveServerRoot: () => 'D:/workspace' };
  const generic = new GenericLlmRuntimeService(
    {} as never,
    {} as never,
    {} as never,
    bindings as never
  ) as unknown as {
    buildRemoteSystemPrompt(input: InvocationPlan): string;
    buildLocalSystemPrompt(input: InvocationPlan): string;
  };
  const codex = new CodexRuntimeAdapterService(bindings as never) as unknown as {
    prompt(input: InvocationPlan): string;
  };
  const claude = new ClaudeCodeRuntimeAdapterService(bindings as never) as unknown as {
    prompt(input: InvocationPlan): string;
  };
  return {
    remote: generic.buildRemoteSystemPrompt(plan),
    local: generic.buildLocalSystemPrompt(plan),
    codex: codex.prompt(plan),
    claude: claude.prompt(plan)
  };
}

test('Post Review uses the v2 post_review phase', () => {
  assert.equal(postReviewPlan().phase, 'post_review');
});

test('Post Review navigation carries the missing source path', () => {
  assert.deepEqual(postReviewPlan().contextEnvelope.L1.navigation.entries.map((entry) => entry.path), ['src/feature.ts']);
});

test('generic remote prompt requires request_workspace_context', () => {
  assert.match(prompts(postReviewPlan()).remote, /request_workspace_context/);
});

test('generic local prompt requires request_workspace_context', () => {
  assert.match(prompts(postReviewPlan()).local, /request_workspace_context/);
});

test('Codex prompt requires request_workspace_context', () => {
  assert.match(prompts(postReviewPlan()).codex, /request_workspace_context/);
});

test('Claude prompt requires request_workspace_context', () => {
  assert.match(prompts(postReviewPlan()).claude, /request_workspace_context/);
});

test('all Post Review prompts require traceable missingPaths', () => {
  for (const prompt of Object.values(prompts(postReviewPlan()))) assert.match(prompt, /missingPaths/);
});

test('Post Review Plan has no private scenario or resume options', () => {
  const plan = postReviewPlan() as unknown as Record<string, unknown>;
  assert.equal('options' in plan, false);
  assert.equal('contextAssembly' in plan, false);
});
