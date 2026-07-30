#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
/**
 * Codex app-server v2 JSONL fixture.
 *
 * Implements initialize → initialized → thread/start|resume → turn/start and
 * emits the official notification names consumed by CodexStreamingRunner.
 */

const stdin = process.stdin;
const stdout = process.stdout;

let buffer = '';
let interrupted = false;
let activeThreadId;
let activeTurnId;
let activeOutputKind = process.env.STUB_KIND ?? 'agent_message';

function send(message) {
  stdout.write(`${JSON.stringify(message)}\n`);
}

function makePayload(kind) {
  switch (kind) {
    case 'task_acceptance_decision':
      return {
        schemaVersion: '1.0',
        kind,
        status: 'accepted',
        reason: 'stub accepted',
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
        summary: '你好世界',
        status: 'completed',
        completedItems: ['stub'],
        changedArtifacts: [],
        requestedContext: null,
        agentMessages: [],
        nextSuggestedActions: [],
        risks: []
      };
    case 'task_brief':
      return {
        schemaVersion: '1.0',
        kind,
        goal: 'stub goal',
        scope: [],
        outOfScope: [],
        constraints: [],
        acceptanceCriteria: [],
        risks: [],
        openQuestions: [],
        suggestedTasks: []
      };
    case 'post_review_report':
      return {
        schemaVersion: '1.0',
        kind,
        isConsistentWithBrief: true,
        matchedItems: [],
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
        summary: 'stub delivery',
        completedItems: [],
        incompleteItems: [],
        risks: [],
        artifactRefs: []
      };
    case 'user_message_handling_plan':
      return {
        schemaVersion: '1.0',
        kind,
        intent: 'question',
        priority: 'normal',
        shouldPause: false,
        affectedTaskIds: [],
        affectedAgentIds: [],
        requiresBriefRevision: false,
        requiresUserConfirmation: false,
        coordinatorInstruction: 'Handle the user message.'
      };
    case 'agent_message':
    default:
      return {
        schemaVersion: '1.0',
        kind: 'agent_message',
        content: '你好世界',
        messageKind: 'summary',
        targetAgentIds: [],
        targetAgentKeys: [],
        mentionedAgentIds: [],
        relatedTaskIds: []
      };
  }
}

function thread(id) {
  return { id, sessionId: id, cwd: process.cwd(), turns: [] };
}

async function runScenario(threadId, turnId) {
  const firstDelay = Number(process.env.STUB_FIRST_DELAY_MS ?? 0);
  if (firstDelay > 0) await new Promise((resolve) => setTimeout(resolve, firstDelay));
  if (interrupted) return;

  send({ method: 'thread/started', params: { thread: thread(threadId) } });
  send({ method: 'remoteControl/status/changed', params: { status: 'disabled' } });
  send({
    method: 'mcpServer/startupStatus/updated',
    params: { server: 'fixture', status: process.env.STUB_MCP_FAIL === '1' ? 'failed' : 'ready' }
  });
  send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'msg-1', delta: '你' } });
  if (process.env.STUB_CRASH === '1') {
    process.exit(1);
    return;
  }
  send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'msg-1', delta: '好世界' } });

  const commandItem = {
    type: 'commandExecution',
    id: 't1',
    command: 'read sample.ts',
    cwd: process.cwd(),
    status: 'inProgress',
    aggregatedOutput: null
  };
  send({ method: 'item/started', params: { threadId, turnId, item: commandItem, startedAtMs: Date.now() } });
  send({
    method: 'item/completed',
    params: {
      threadId,
      turnId,
      item: { ...commandItem, status: 'completed', aggregatedOutput: '/* content */', exitCode: 0 },
      completedAtMs: Date.now()
    }
  });
  send({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId,
      tokenUsage: {
        total: { inputTokens: 42, cachedInputTokens: 0, outputTokens: 24, totalTokens: 66, reasoningOutputTokens: 0 },
        last: { inputTokens: 42, cachedInputTokens: 0, outputTokens: 24, totalTokens: 66, reasoningOutputTokens: 0 },
        modelContextWindow: 200000
      }
    }
  });

  if (
    activeOutputKind === 'task_execution_result' &&
    (process.env.CODEX_RUNTIME_STUB_EDIT_FILES ?? process.env.STUB_EDIT_FILES) === 'codex'
  ) {
    mkdirSync('src', { recursive: true });
    writeFileSync('src/feature.txt', 'after from codex stub\n');
    writeFileSync('src/generated-by-codex.txt', 'created by codex stub\n');
  }
  const payload = makePayload(activeOutputKind);
  send({
    method: 'item/completed',
    params: {
      threadId,
      turnId,
      item: {
        type: 'agentMessage',
        id: 'msg-1',
        text: JSON.stringify(payload),
        phase: 'final_answer',
        memoryCitation: null
      },
      completedAtMs: Date.now()
    }
  });
  send({
    method: 'turn/completed',
    params: {
      threadId,
      turn: {
        id: turnId,
        status: 'completed',
        items: [],
        error: null
      }
    }
  });
  setTimeout(() => process.exit(0), 20);
}

function handle(message) {
  if (message.method === 'initialize' && message.id !== undefined) {
    send({
      id: message.id,
      result: { userAgent: 'codex-stub', codexHome: process.cwd(), platformFamily: 'windows', platformOs: 'windows' }
    });
    return;
  }
  if (message.method === 'initialized') return;

  if ((message.method === 'thread/start' || message.method === 'thread/resume') && message.id !== undefined) {
    if (message.method === 'thread/resume' && process.env.STUB_RESUME_FAIL === '1') {
      send({ id: message.id, error: { code: -32001, message: 'resume failed' } });
      return;
    }
    const requested = message.params?.threadId;
    activeThreadId =
      process.env.STUB_RESUME_MISMATCH === '1'
        ? 'unexpected-thread'
        : requested || process.env.STUB_SESSION_ID || 'stub-session-1';
    send({ id: message.id, result: { thread: thread(activeThreadId), cwd: process.cwd() } });
    return;
  }

  if (message.method === 'turn/start' && message.id !== undefined) {
    activeThreadId = message.params?.threadId || activeThreadId || 'stub-session-1';
    activeTurnId = 'stub-turn-1';
    const schemaKind = message.params?.outputSchema?.properties?.kind?.const;
    activeOutputKind = typeof schemaKind === 'string' ? schemaKind : activeOutputKind;
    send({ id: message.id, result: { turn: { id: activeTurnId, status: 'inProgress', items: [], error: null } } });
    void runScenario(activeThreadId, activeTurnId);
    return;
  }

  if (message.method === 'turn/interrupt' && message.id !== undefined) {
    interrupted = true;
    send({ id: message.id, result: {} });
    send({
      method: 'turn/completed',
      params: {
        threadId: message.params?.threadId || activeThreadId,
        turn: {
          id: message.params?.turnId || activeTurnId || 'stub-turn-1',
          status: 'interrupted',
          items: [],
          error: null
        }
      }
    });
    setTimeout(() => process.exit(0), 20);
  }
}

function drain() {
  while (true) {
    const newlineIndex = buffer.indexOf('\n');
    if (newlineIndex === -1) return;
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // Ignore malformed client input in the fixture.
    }
  }
}

stdin.setEncoding('utf8');
stdin.on('data', (chunk) => {
  buffer += chunk;
  drain();
});
