import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

const RUN_FLAG = 'RUN_REAL_CLAUDE_ACCEPTANCE';

function shouldRunRealClaude(): boolean {
  return process.env[RUN_FLAG] === '1' || process.env[RUN_FLAG] === 'true';
}

test('real Claude acceptance skips safely when the gating environment variable is not set', () => {
  if (shouldRunRealClaude()) return;
  assert.equal(shouldRunRealClaude(), false);
  assert.equal(Boolean(process.env.CLAUDE_CODE_ENABLED), false);
});

test('real Claude acceptance delegates to the gated real CLI acceptance when enabled', { skip: !shouldRunRealClaude() }, async () => {
  await runNodeScript('tests/e2e/real-cli-acceptance.mjs', {
    RUN_REAL_CLI_ACCEPTANCE: 'true',
    REAL_CLI_RUNTIME: 'claude_code',
    REAL_CLI_PHASE: process.env.REAL_CLAUDE_ACCEPTANCE_PHASE ?? 'probe',
    REAL_CLI_RUNS_PER_RUNTIME: process.env.REAL_CLAUDE_ACCEPTANCE_RUNS ?? '3'
  });
});

function runNodeScript(script: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: { ...process.env, ...env }
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with ${code}`));
    });
    child.on('error', reject);
  });
}
