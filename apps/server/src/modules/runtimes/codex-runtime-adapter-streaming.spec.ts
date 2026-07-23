import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildClaudeStreamingOptions } from './claude-code-runtime-adapter.service.js';
import { buildCodexStreamingOptions } from './codex-runtime-adapter.service.js';

const codexSource = readFileSync(new URL('./codex-runtime-adapter.service.ts', import.meta.url), 'utf8');
const claudeSource = readFileSync(new URL('./claude-code-runtime-adapter.service.ts', import.meta.url), 'utf8');
const base = {
  command: 'runtime-cli',
  args: ['--stream'],
  baseEnv: { PATH: '/usr/bin' } as Record<string, string | undefined>,
  firstFrameTimeoutMs: 30_000,
  idleTimeoutMs: 600_000,
  absoluteTimeoutMs: 900_000
};

test('Codex options builder does not accept InvocationPlan', () => {
  const block = codexSource.slice(codexSource.indexOf('export function buildCodexStreamingOptions'), codexSource.indexOf('const execFileAsync'));
  assert.doesNotMatch(block, /InvocationPlan|input:/);
});

test('Claude options builder does not accept InvocationPlan', () => {
  const block = claudeSource.slice(claudeSource.indexOf('export function buildClaudeStreamingOptions'), claudeSource.indexOf('const execFileAsync'));
  assert.doesNotMatch(block, /InvocationPlan|input:/);
});

test('Codex uses only the internally resolved workDir as cwd', () => {
  assert.equal(buildCodexStreamingOptions({ ...base, workDir: '/workspace' }).cwd, '/workspace');
});

test('Claude uses only the internally resolved workDir as cwd', () => {
  assert.equal(buildClaudeStreamingOptions({ ...base, workDir: '/workspace' }).cwd, '/workspace');
});

test('Codex does not inject a resume environment variable', () => {
  const options = buildCodexStreamingOptions(base);
  assert.equal(options.env?.AGENT_CLUSTER_CODEX_RESUME_ID, undefined);
});

test('Claude does not append a resume CLI argument', () => {
  const options = buildClaudeStreamingOptions(base);
  assert.equal(options.args.includes('--resume'), false);
});

test('Codex maps an explicit v2 resume request to app-server thread resume', () => {
  const options = buildCodexStreamingOptions({ ...base, resumeCliSessionId: 'codex-session-1' });
  assert.equal(options.resumeCliSessionId, 'codex-session-1');
});

test('Codex streaming options preserve the adapter shell policy', () => {
  assert.equal(buildCodexStreamingOptions({ ...base, shell: true }).shell, true);
  assert.equal(buildCodexStreamingOptions({ ...base, shell: false }).shell, false);
});

test('Claude maps an explicit v2 resume request to the native CLI argument', () => {
  const options = buildClaudeStreamingOptions({ ...base, resumeCliSessionId: 'claude-session-1' });
  assert.deepEqual(options.args.slice(-2), ['--resume', 'claude-session-1']);
});

test('builders copy caller-owned arguments and environment', () => {
  const codex = buildCodexStreamingOptions(base);
  const claude = buildClaudeStreamingOptions(base);
  assert.notEqual(codex.env, base.baseEnv);
  assert.notEqual(claude.args, base.args);
  assert.deepEqual(codex.args, base.args);
  assert.deepEqual(claude.env, base.baseEnv);
});

test('builders preserve watchdog timeout configuration', () => {
  for (const options of [buildCodexStreamingOptions(base), buildClaudeStreamingOptions(base)]) {
    assert.equal(options.firstFrameTimeoutMs, 30_000);
    assert.equal(options.idleTimeoutMs, 600_000);
    assert.equal(options.absoluteTimeoutMs, 900_000);
  }
});
