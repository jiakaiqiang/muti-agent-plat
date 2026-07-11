import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stubPath = join(__dirname, 'codex-appserver-stub.mjs');

async function collectStubMessages(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [stubPath], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'inherit']
    });
    const messages = [];
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        messages.push(message);
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'thread/start', params: { cwd: process.cwd() } })}\n`);
        } else if (message.id === 2) {
          child.stdin.write(`${JSON.stringify({ id: 3, method: 'turn/start', params: { threadId: message.result.thread.id, input: [] } })}\n`);
        }
      }
    });
    child.on('error', reject);
    child.on('close', () => resolve(messages));
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'fixture-test', version: '0.1.0' }, capabilities: null } })}\n`);
  });
}

test('codex app-server stub emits official lifecycle notifications', async () => {
  const messages = await collectStubMessages();
  const methods = messages.filter((message) => message.method).map((message) => message.method);
  assert.ok(methods.includes('item/agentMessage/delta'));
  assert.ok(methods.includes('item/started'));
  assert.ok(methods.includes('item/completed'));
  assert.ok(methods.includes('thread/tokenUsage/updated'));
  assert.ok(methods.includes('turn/completed'));
  const completed = messages.find((message) => message.method === 'turn/completed');
  assert.equal(completed.params.threadId, 'stub-session-1');
});

test('codex app-server stub crash exits before turn completion', async () => {
  const messages = await collectStubMessages({ STUB_CRASH: '1' });
  assert.ok(messages.some((message) => message.method === 'item/agentMessage/delta'));
  assert.ok(!messages.some((message) => message.method === 'turn/completed'));
});

test('codex app-server stub supports resume failure', async () => {
  const child = spawn(process.execPath, [stubPath], {
    env: { ...process.env, STUB_RESUME_FAIL: '1' },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  const lines = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => lines.push(...chunk.trim().split('\n').filter(Boolean)));
  child.stdin.write(`${JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'old' } })}\n`);
  const response = await new Promise((resolve) => {
    child.stdout.once('data', (chunk) => resolve(JSON.parse(chunk.trim())));
  });
  child.kill();
  assert.equal(response.error.message, 'resume failed');
});
