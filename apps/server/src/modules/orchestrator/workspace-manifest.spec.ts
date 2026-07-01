import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceSnapshot } from '@agent-cluster/shared';
import { buildCoverageSystemRule, buildWorkspaceManifest } from './workspace-manifest.js';

function snapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    rootName: 'demo',
    scannedAt: '2026-06-30T00:00:00.000Z',
    fileCount: 2,
    totalBytes: 100,
    tree: [{ path: 'src', kind: 'directory' }],
    files: [
      { path: 'src/a.ts', size: 50, language: 'typescript', content: 'export const a = 1\n' }
    ],
    skipped: [],
    detectedStack: ['typescript'],
    entrypoints: ['src/a.ts'],
    ...overrides
  };
}

test('buildWorkspaceManifest returns undefined when snapshot is missing', () => {
  assert.equal(buildWorkspaceManifest(undefined), undefined);
});

test('buildWorkspaceManifest strips file content but threads coverage when present', () => {
  const manifest = buildWorkspaceManifest(
    snapshot({
      coverage: {
        totalEntriesSeen: 12,
        scannedEntries: 10,
        readableFiles: 1,
        skippedByReason: { sensitive: 1, ignored_directory: 1 }
      }
    })
  );
  assert.ok(manifest);
  assert.equal(manifest.rootName, 'demo');
  assert.equal(manifest.readableFileCount, 1);
  // File content must not leak into manifest (it ships via selectedEvidenceContents).
  assert.equal((manifest.files[0] as { content?: string }).content, undefined);
  assert.equal(manifest.files[0].contentLength, 'export const a = 1\n'.length);
  assert.ok(manifest.coverage, 'coverage must be threaded to manifest');
  assert.equal(manifest.coverage.totalEntriesSeen, 12);
  assert.equal(manifest.coverage.skippedByReason.sensitive, 1);
});

test('buildCoverageSystemRule returns undefined when snapshot is missing', () => {
  assert.equal(buildCoverageSystemRule(undefined), undefined);
});

test('buildCoverageSystemRule returns undefined when coverage is full and nothing skipped', () => {
  const rule = buildCoverageSystemRule(
    snapshot({
      coverage: {
        totalEntriesSeen: 5,
        scannedEntries: 5,
        readableFiles: 5,
        skippedByReason: {}
      }
    })
  );
  assert.equal(rule, undefined);
});

test('buildCoverageSystemRule surfaces partial scan with CONTEXT_INSUFFICIENT hint', () => {
  const rule = buildCoverageSystemRule(
    snapshot({
      coverage: {
        totalEntriesSeen: 400,
        scannedEntries: 350,
        readableFiles: 80,
        skippedByReason: { limit_exceeded: 50, sensitive: 1 }
      }
    })
  );
  assert.ok(rule, 'rule should be present when scan is partial');
  assert.ok(rule.includes('CONTEXT_INSUFFICIENT'), `rule should mention CONTEXT_INSUFFICIENT, got: ${rule}`);
  assert.ok(rule.includes('350'), 'rule should mention scannedEntries');
  assert.ok(rule.includes('400'), 'rule should mention totalEntriesSeen');
});

test('buildCoverageSystemRule surfaces fully-scanned-but-skipped workspace', () => {
  // Everything visible was scanned (no limit_exceeded), but some entries were dropped (sensitive/binary).
  // Runtime still needs to know coverage is partial so it can pull missing content if relevant.
  const rule = buildCoverageSystemRule(
    snapshot({
      coverage: {
        totalEntriesSeen: 10,
        scannedEntries: 10,
        readableFiles: 7,
        skippedByReason: { sensitive: 2, binary: 1 }
      }
    })
  );
  assert.ok(rule, 'rule should be present when files were skipped even if all entries were enumerated');
  assert.ok(rule.includes('CONTEXT_INSUFFICIENT'));
});
