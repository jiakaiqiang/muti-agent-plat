import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceIndexEntry, WorkspaceRevision } from '@agent-cluster/shared';
import { scoreEvidenceCandidates } from './score-evidence-candidates.js';

const revision = {
  id: 'revision-73',
  observedAt: '2026-07-11T00:00:00.000Z'
} satisfies WorkspaceRevision;

function file(path: string, opts: { generated?: boolean; sensitive?: boolean } = {}): WorkspaceIndexEntry {
  return {
    path,
    kind: 'file',
    size: 100,
    hash: { algorithm: 'sha256', value: 'e'.repeat(64) },
    revision,
    generated: opts.generated ?? false,
    sensitive: opts.sensitive ?? false
  };
}

test('scoreEvidenceCandidates ranks user-mentioned files above entrypoints and contracts', () => {
  const entries = [
    file('src/util.ts'),
    file('src/entry.ts'),
    file('packages/shared/contracts.ts'),
    file('src/mentioned.ts')
  ];
  const ranked = scoreEvidenceCandidates({
    entries,
    entrypoints: ['src/entry.ts'],
    userMentionedPaths: ['src/mentioned.ts']
  });
  assert.equal(ranked[0].path, 'src/mentioned.ts');
  assert.ok(ranked.map((r) => r.path).includes('src/entry.ts'));
  assert.ok(ranked.map((r) => r.path).includes('packages/shared/contracts.ts'));
});

test('scoreEvidenceCandidates rewards keyword matches in path', () => {
  const entries = [
    file('src/auth/session.ts'),
    file('src/util.ts')
  ];
  const ranked = scoreEvidenceCandidates({
    entries,
    userKeywords: ['auth', 'session']
  });
  assert.equal(ranked[0].path, 'src/auth/session.ts');
});

test('scoreEvidenceCandidates drops generated and sensitive files', () => {
  const entries = [
    file('src/entry.ts'),
    file('dist/output.js', { generated: true }),
    file('.env', { sensitive: true })
  ];
  const ranked = scoreEvidenceCandidates({
    entries,
    entrypoints: ['src/entry.ts', 'dist/output.js', '.env']
  });
  const paths = ranked.map((r) => r.path);
  assert.equal(paths.includes('dist/output.js'), false);
  assert.equal(paths.includes('.env'), false);
});

test('scoreEvidenceCandidates records reasons on each candidate', () => {
  const entries = [file('src/auth/entry.ts'), file('src/util.spec.ts')];
  const ranked = scoreEvidenceCandidates({
    entries,
    entrypoints: ['src/auth/entry.ts'],
    userKeywords: ['auth']
  });
  const entry = ranked.find((r) => r.path === 'src/auth/entry.ts');
  const spec = ranked.find((r) => r.path === 'src/util.spec.ts');
  assert.ok(entry);
  assert.ok(entry!.reasons.includes('entrypoint'));
  assert.ok(entry!.reasons.some((reason) => reason.startsWith('keyword-match')));
  assert.ok(spec);
  assert.ok(spec!.reasons.includes('test'));
});
