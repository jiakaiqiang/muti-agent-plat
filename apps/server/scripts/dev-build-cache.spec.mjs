import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  shouldBuildDevServer,
  sourceTreeFingerprint,
  writeDevBuildStamp
} from './dev-build-cache.mjs';

test('development build cache rebuilds only when source content changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-cluster-dev-build-cache-'));
  const sourceRoot = join(root, 'src');
  const outputPath = join(root, 'dist', 'main.js');
  const stampPath = join(root, '.cache', 'dev-build.json');
  try {
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(sourceRoot, 'main.ts'), 'export const value = 1;\n', 'utf8');

    const missingOutput = shouldBuildDevServer({ roots: [sourceRoot], stampPath, outputPath });
    assert.equal(missingOutput.build, true);
    assert.equal(missingOutput.reason, 'output_missing');

    writeFileSync(outputPath, 'compiled\n', 'utf8');
    writeDevBuildStamp(stampPath, sourceTreeFingerprint([sourceRoot]));
    assert.deepEqual(
      shouldBuildDevServer({ roots: [sourceRoot], stampPath, outputPath }),
      { build: false, fingerprint: missingOutput.fingerprint, reason: 'source_unchanged' }
    );

    writeFileSync(join(sourceRoot, 'main.ts'), 'export const value = 2;\n', 'utf8');
    const changed = shouldBuildDevServer({ roots: [sourceRoot], stampPath, outputPath });
    assert.equal(changed.build, true);
    assert.equal(changed.reason, 'source_changed');
    assert.notEqual(changed.fingerprint, missingOutput.fingerprint);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
