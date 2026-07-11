#!/usr/bin/env node
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

function send(message) {
  stdout.write(`${JSON.stringify(message)}\n`);
}

function makePayload(kind) {
  switch (kind) {
    case 'task_execution_result':
      return {
        kind,
        summary: '你好世界',
        status: 'completed',
        completedItems: ['stub'],
        changedArtifacts: [],
        nextSuggestedActions: [],
        risks: []
      };
    case 'task_brief':
      return {
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
    case 'agent_message':
    default:
      return { kind: 'agent_message', content: '你好世界', messageKind: 'summary' };
  }
}

function thread(id) {
  return { id, sessionId: id, cwd: process.cwd(), turns: [] };
}

async function runScenario(threadId, turnId) {
  const firstDelay = Number(process.env.STUB_FIRST_DELAY_MS ?? 0);
  if (firstDelay > 0) await new Promise((resolve) => setTimeout(resolve, firstDelay));
  if (interrupted) return;

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

  const payload = makePayload(process.env.STUB_KIND ?? 'agent_message');
  send({
    method: 'turn/completed',
    params: {
      threadId,
      turn: {
        id: turnId,
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'msg-1', text: JSON.stringify(payload), phase: 'final_answer', memoryCitation: null }],
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
