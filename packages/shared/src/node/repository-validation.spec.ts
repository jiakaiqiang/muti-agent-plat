import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRepositoryValidation, runRepositoryValidation } from './repository-validation.js';

test('validation discovery reads package scripts as structured data and asks when none is reliable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repository-validation-'));
  try {
    assert.equal(await detectRepositoryValidation(root), undefined);
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: {
      test: 'echo "Error: no test specified" && exit 1', typecheck: 'tsc --noEmit'
    } }));
    assert.deepEqual(await detectRepositoryValidation(root), {
      program: 'npm', args: ['run', 'typecheck'], relativeCwd: '.'
    });
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    assert.deepEqual(await detectRepositoryValidation(root), {
      program: 'npm', args: ['run', 'test'], relativeCwd: '.'
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('validation runner records actual process exit and does not persist command output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repository-validation-run-'));
  try {
    const failed = await runRepositoryValidation({ root, candidateSha: 'a'.repeat(40),
      command: { program: process.execPath, args: ['-e',
        "process.stdout.write('github_pat_secret'); process.exit(7)"], relativeCwd: '.' } });
    assert.equal(failed.exitCode, 7);
    assert.equal(failed.candidateSha, 'a'.repeat(40));
    assert.doesNotMatch(failed.outputSummary, /github_pat_secret/);
    const passed = await runRepositoryValidation({ root, candidateSha: 'b'.repeat(40),
      command: { program: process.execPath, args: ['-e', 'process.exit(0)'], relativeCwd: '.' } });
    assert.equal(passed.exitCode, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('validation timeout stops the process and reports a failed validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repository-validation-timeout-'));
  try {
    const timedOut = await runRepositoryValidation({ root, candidateSha: 'c'.repeat(40),
      command: { program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
        relativeCwd: '.' }, timeoutMs: 1_000 });
    assert.equal(timedOut.exitCode, -1);
    assert.match(timedOut.outputSummary, /timed_out/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
