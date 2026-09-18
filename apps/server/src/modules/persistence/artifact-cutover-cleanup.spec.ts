import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeArtifactCleanup, planArtifactCleanup } from './artifact-cutover-cleanup.js';

function setup() {
  const parent = mkdtempSync(join(tmpdir(), 'agent-cluster-artifact-cutover-'));
  const dataRoot = join(parent, 'data');
  const outsideRoot = join(parent, 'workspace');
  mkdirSync(join(dataRoot, 'artifacts'), { recursive: true });
  mkdirSync(outsideRoot, { recursive: true });
  return {
    parent,
    dataRoot,
    outsideRoot,
    cleanup: () => rmSync(parent, { recursive: true, force: true })
  };
}

test('Artifact plan reads only persisted Artifact URI records', () => {
  const fixture = setup();
  try {
    const plan = planArtifactCleanup({
      artifacts: [{ id: 'a-1', uri: 'artifacts/report.md' }, { id: 'a-2' }],
      sessions: [{ id: 's-1', uri: 'artifacts/not-an-artifact.md' }]
    }, fixture.dataRoot);
    assert.equal(plan.targets.length, 1);
    assert.equal(plan.blocked.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('Artifact plan reads the production artifactsById persistence shape', () => {
  const fixture = setup();
  try {
    const plan = planArtifactCleanup({
      artifacts: {
        artifactsById: {
          'a-1': { id: 'a-1', uri: 'artifacts/report.md' }
        },
        artifactIdsBySession: { 'session-1': ['a-1'] }
      }
    }, fixture.dataRoot);
    assert.equal(plan.targets.length, 1);
    assert.equal(plan.targets[0]?.artifactId, 'a-1');
  } finally {
    fixture.cleanup();
  }
});

test('Artifact plan resolves relative URIs under the platform data root', () => {
  const fixture = setup();
  try {
    const plan = planArtifactCleanup({ artifacts: [{ id: 'a-1', uri: 'artifacts/report.md' }] }, fixture.dataRoot);
    assert.equal(plan.targets[0]?.path, join(fixture.dataRoot, 'artifacts', 'report.md'));
  } finally {
    fixture.cleanup();
  }
});

test('Artifact plan blocks external HTTP and file URIs', () => {
  const fixture = setup();
  try {
    const plan = planArtifactCleanup({
      artifacts: [
        { id: 'a-http', uri: 'https://example.com/report.md' },
        { id: 'a-file', uri: 'file:///workspace/report.md' }
      ]
    }, fixture.dataRoot);
    assert.deepEqual(plan.blocked.map((item) => item.code), ['ARTIFACT_PATH_EXTERNAL_URI', 'ARTIFACT_PATH_EXTERNAL_URI']);
  } finally {
    fixture.cleanup();
  }
});

test('Artifact plan blocks absolute and relative paths outside the data root', () => {
  const fixture = setup();
  try {
    const plan = planArtifactCleanup({
      artifacts: [
        { id: 'a-absolute', uri: join(fixture.outsideRoot, 'report.md') },
        { id: 'a-relative', uri: '../workspace/report.md' }
      ]
    }, fixture.dataRoot);
    assert.deepEqual(plan.blocked.map((item) => item.code), ['ARTIFACT_PATH_OUTSIDE_DATA_ROOT', 'ARTIFACT_PATH_OUTSIDE_DATA_ROOT']);
  } finally {
    fixture.cleanup();
  }
});

test('planning is dry-run only and never deletes an Artifact file', () => {
  const fixture = setup();
  try {
    const path = join(fixture.dataRoot, 'artifacts', 'report.md');
    writeFileSync(path, 'keep during dry-run', 'utf8');
    planArtifactCleanup({ artifacts: [{ id: 'a-1', uri: path }] }, fixture.dataRoot);
    assert.equal(readFileSync(path, 'utf8'), 'keep during dry-run');
  } finally {
    fixture.cleanup();
  }
});

test('Artifact cleanup deletes a guarded file inside the data root', () => {
  const fixture = setup();
  try {
    const path = join(fixture.dataRoot, 'artifacts', 'report.md');
    writeFileSync(path, 'delete on apply', 'utf8');
    const result = executeArtifactCleanup(
      planArtifactCleanup({ artifacts: [{ id: 'a-1', uri: path }] }, fixture.dataRoot)
    );
    assert.equal(existsSync(path), false);
    assert.deepEqual(result, { deletedCount: 1, missingCount: 0 });
  } finally {
    fixture.cleanup();
  }
});

test('Artifact cleanup treats an already missing file as idempotent', () => {
  const fixture = setup();
  try {
    const plan = planArtifactCleanup({ artifacts: [{ id: 'a-1', uri: 'artifacts/missing.md' }] }, fixture.dataRoot);
    assert.deepEqual(executeArtifactCleanup(plan), { deletedCount: 0, missingCount: 1 });
  } finally {
    fixture.cleanup();
  }
});

test('Artifact cleanup refuses to run a plan containing blocked paths', () => {
  const fixture = setup();
  try {
    const plan = planArtifactCleanup({ artifacts: [{ id: 'a-1', uri: '../workspace/report.md' }] }, fixture.dataRoot);
    assert.throws(() => executeArtifactCleanup(plan), /ARTIFACT_CLEANUP_BLOCKED/);
  } finally {
    fixture.cleanup();
  }
});

test('Artifact cleanup blocks a symlink that escapes the data root', (context) => {
  const fixture = setup();
  let junctionLink: string | undefined;
  try {
    const outside = join(fixture.outsideRoot, 'secret.md');
    const link = join(fixture.dataRoot, 'artifacts', 'linked.md');
    writeFileSync(outside, 'do not delete', 'utf8');
    // The Artifact URI the planner must block. With a file symlink it is the link
    // itself; with the junction fallback it is a file reached *through* the
    // junction, because the junction directory itself would be rejected earlier
    // as ARTIFACT_PATH_NOT_FILE rather than as an escaping path.
    let blockedUri = link;
    let carrier: 'file-symlink' | 'junction' | undefined;
    try {
      symlinkSync(outside, link, 'file');
      // Trust lstat, not symlinkSync()'s return value: some Windows/sandbox
      // environments report success while creating a regular file instead.
      if (lstatSync(link).isSymbolicLink()) carrier = 'file-symlink';
    } catch {
      carrier = undefined;
    }
    if (!carrier && process.platform === 'win32') {
      // Directory junctions need no elevation on Windows and are genuine reparse
      // points, so realpath resolves a path through them to `outsideRoot`.
      junctionLink = join(fixture.dataRoot, 'artifacts', 'linked-dir');
      try {
        symlinkSync(fixture.outsideRoot, junctionLink, 'junction');
        if (lstatSync(junctionLink).isSymbolicLink()) {
          carrier = 'junction';
          blockedUri = join(junctionLink, 'secret.md');
        }
      } catch {
        carrier = undefined;
      }
    }
    if (!carrier) {
      // No real escaping link available on this host; Linux CI still exercises
      // the file-symlink fixture end to end. Reported as a real skip so the
      // coverage gap shows up in the skipped count.
      context.skip('no real escaping link could be created on this host');
      return;
    }
    const plan = planArtifactCleanup({ artifacts: [{ id: 'a-link', uri: blockedUri }] }, fixture.dataRoot);
    assert.equal(plan.blocked[0]?.code, 'ARTIFACT_PATH_SYMLINK_ESCAPE');
    assert.equal(readFileSync(outside, 'utf8'), 'do not delete');
    context.diagnostic(`escaping link carrier: ${carrier}, blocked uri: ${blockedUri}`);
  } finally {
    // Drop the reparse point before the recursive fixture cleanup — including on
    // assertion failure — so removal can never traverse it into the outside tree.
    if (junctionLink) rmSync(junctionLink, { recursive: false, force: true });
    fixture.cleanup();
  }
});
