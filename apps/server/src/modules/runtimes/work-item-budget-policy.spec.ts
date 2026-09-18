import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRunPhase, RuntimeAttemptTrace } from '@agent-cluster/shared';
import {
  WORK_ITEM_BUDGET_EXHAUSTED_CODE,
  budgetCategoryFor,
  workItemBudgetExhaustedMessage
} from './work-item-budget-policy.js';

test('every counted surface maps to its own category', () => {
  assert.equal(budgetCategoryFor('user_message_routing'), 'classification');
  assert.equal(budgetCategoryFor('discussion'), 'consultation');
  assert.equal(budgetCategoryFor('brief_consultation'), 'consultation');
  assert.equal(budgetCategoryFor('task_execution'), 'execution');
  assert.equal(budgetCategoryFor('brief_generation'), 'execution');
  assert.equal(budgetCategoryFor('post_review'), 'execution');
});

test('retry and supplemental read win over the phase they happen in', () => {
  // A retried classification is charged as a retry: AC6 counts retries as their
  // own surface instead of hiding them inside the phase's total.
  assert.equal(budgetCategoryFor('user_message_routing', { attemptGroupId: 'g', attempt: 2 }), 'retry');
  assert.equal(
    budgetCategoryFor('task_execution', { attemptGroupId: 'g', attempt: 1, retryOfInvocationId: 'previous' }),
    'retry'
  );
  // Supplemental read must stay attributable even during execution.
  assert.equal(
    budgetCategoryFor('task_execution', { attemptGroupId: 'g', attempt: 1, supplementalContextAttempt: 1 }),
    'supplemental_read'
  );
  assert.equal(
    budgetCategoryFor('task_execution', {
      attemptGroupId: 'g',
      attempt: 2,
      retryOfInvocationId: 'previous',
      supplementalContextAttempt: 1
    }),
    'supplemental_read'
  );
});

test('a first attempt without retry evidence is charged to its phase', () => {
  const firstAttempt: RuntimeAttemptTrace = { attemptGroupId: 'group', attempt: 1 };
  assert.equal(budgetCategoryFor('discussion', firstAttempt), 'consultation');
  assert.equal(budgetCategoryFor('task_execution', firstAttempt), 'execution');
});

test('exhaustion explains itself in Chinese without leaking English budget wording', () => {
  const message = workItemBudgetExhaustedMessage({
    availableTokens: 120,
    requestedTokens: 900,
    limitTokens: 1_000
  });
  assert.match(message, /累计模型预算已不足/, 'the capacity block must be explained in Chinese');
  assert.match(message, /120/, 'the remaining allowance must be quoted');
  assert.match(message, /900/, 'the refused request must be quoted');
  assert.match(message, /不会静默截断/, 'callers must be told this is a block, not a truncation');
  assert.doesNotMatch(message, /budget exceeded/i, 'no English budget wording may surface');
});

test('the exhausted code is a stable identifier callers can branch on', () => {
  assert.equal(WORK_ITEM_BUDGET_EXHAUSTED_CODE, 'WORK_ITEM_BUDGET_EXHAUSTED');
  assert.match(WORK_ITEM_BUDGET_EXHAUSTED_CODE, /^[A-Z_]+$/, 'codes stay upper snake case like the rest of the runtime');
});

test('phases are exhaustively classified so a new phase cannot silently escape the ledger', () => {
  const phases: AgentRunPhase[] = [
    'discussion',
    'brief_generation',
    'brief_revision',
    'brief_consultation',
    'task_acceptance',
    'task_execution',
    'revision_synthesis',
    'post_review',
    'final_delivery',
    'user_message_routing'
  ];
  for (const phase of phases) {
    const category = budgetCategoryFor(phase);
    assert.ok(
      ['classification', 'consultation', 'retry', 'summary', 'supplemental_read', 'execution'].includes(category),
      `${phase} must be charged to a known category`
    );
  }
});
