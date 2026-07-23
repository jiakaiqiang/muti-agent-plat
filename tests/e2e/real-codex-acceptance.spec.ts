import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

const RUN_FLAG = 'RUN_REAL_CODEX_ACCEPTANCE';

function shouldRunRealCodex(): boolean {
  return process.env[RUN_FLAG] === '1' || process.env[RUN_FLAG] === 'true';
}

test('real Codex acceptance skips safely when the gating environment variable is not set', () => {
  if (shouldRunRealCodex()) return;
  assert.equal(shouldRunRealCodex(), false);
  assert.equal(Boolean(process.env.CODEX_RUNTIME_ENABLED), false);
});

test('real Codex acceptance delegates to the gated real CLI acceptance when enabled', { skip: !shouldRunRealCodex() }, async () => {
  await runNodeScript('tests/e2e/real-cli-acceptance.mjs', {
    RUN_REAL_CLI_ACCEPTANCE: 'true',
    REAL_CLI_RUNTIME: 'codex',
    REAL_CLI_PHASE: process.env.REAL_CODEX_ACCEPTANCE_PHASE ?? 'probe',
    REAL_CLI_RUNS_PER_RUNTIME: process.env.REAL_CODEX_ACCEPTANCE_RUNS ?? '3'
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
