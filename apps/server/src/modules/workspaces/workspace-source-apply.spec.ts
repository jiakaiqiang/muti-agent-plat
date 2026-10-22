import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceChangeSet } from '@agent-cluster/shared';
import { ServerLocalWorkspaceProvider } from './server-local-workspace-provider.js';

const hash = (text: string) => ({ algorithm: 'sha256' as const, value: createHash('sha256').update(text).digest('hex') });
type Guard = (rootPath: string, changeSet: WorkspaceChangeSet) => Promise<void>;
type Guarded = { applyChangeSetGuarded(changeSet: WorkspaceChangeSet, guard: Guard): Promise<{ ok: boolean }> };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'r10-source-apply-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = new ServerLocalWorkspaceProvider(root);
  const baseRevision = await provider.getRevision();
  const changeSet = (changes: WorkspaceChangeSet['changes']): WorkspaceChangeSet => ({
    id: 'candidate', baseRevision, createdAt: new Date().toISOString(), changes
  });
  return { root, provider: provider as unknown as Guarded, changeSet };
}

test('source apply invokes its mandatory guard before touching an unauthorized real file', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'file.ts'), 'old');
  const before = hash(await readFile(join(f.root, 'file.ts'), 'utf8'));
  await assert.rejects(f.provider.applyChangeSetGuarded(f.changeSet([
    { operation: 'update', path: 'file.ts', content: 'new', encoding: 'utf-8', expectedHash: hash('old') }
  ]), async root => { assert.equal(root, f.root); throw new Error('SOURCE_SCOPE_REJECTED'); }), /SOURCE_SCOPE_REJECTED/);
  assert.deepEqual(hash(await readFile(join(f.root, 'file.ts'), 'utf8')), before);
});

test('source apply revalidates the actual merged content while holding file locks', async t => {
  const f = await fixture(t);
  const base = 'export const first = 1;\nexport const second = 2;\n';
  const current = base.replace('first = 1', 'first = 3');
  const proposed = base.replace('second = 2', 'second = 4');
  await writeFile(join(f.root, 'file.ts'), current);
  const observed: string[] = [];
  const result = await f.provider.applyChangeSetGuarded(f.changeSet([
    { operation: 'update', path: 'file.ts', content: proposed, baseContent: base, encoding: 'utf-8', expectedHash: hash(base) }
  ]), async (_, changeSet) => {
    const part = changeSet.changes[0];
    assert.equal(part.operation, 'update');
    if (part.operation === 'update') observed.push(part.content);
  });
  assert.equal(result.ok, true);
  const actual = await readFile(join(f.root, 'file.ts'), 'utf8');
  assert.match(actual, /first = 3/);
  assert.match(actual, /second = 4/);
  assert.equal(observed[observed.length - 1], actual);
  assert.ok(observed.length >= 2, 'must validate again after the merge');
});

test('a late source authorization failure rolls back previously applied files', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'first.ts'), 'one');
  await writeFile(join(f.root, 'second.ts'), 'two');
  let calls = 0;
  await assert.rejects(f.provider.applyChangeSetGuarded(f.changeSet([
    { operation: 'update', path: 'first.ts', content: 'new one', encoding: 'utf-8', expectedHash: hash('one') },
    { operation: 'update', path: 'second.ts', content: 'new two', encoding: 'utf-8', expectedHash: hash('two') }
  ]), async () => {
    calls += 1;
    if (calls === 4) throw new Error('SOURCE_AUTHORITY_REVOKED');
  }), /SOURCE_AUTHORITY_REVOKED/);
  assert.equal(calls, 4);
  assert.equal(await readFile(join(f.root, 'first.ts'), 'utf8'), 'one');
  assert.equal(await readFile(join(f.root, 'second.ts'), 'utf8'), 'two');
});

test('an I/O error after a partial write reports an unknown effect and cannot release the apply fence', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'file.ts'), 'old');
  const originalWrite = fsPromises.writeFile;
  try {
    fsPromises.writeFile = async (file, data, options) => {
      if (file === join(f.root, 'file.ts') || (typeof file === 'object' && file !== null && 'fd' in file)) {
        await originalWrite(file, 'partial');
        throw Object.assign(new Error('simulated partial write'), { code: 'EIO' });
      }
      return originalWrite(file, data, options);
    };
    syncBuiltinESMExports();
    await assert.rejects(f.provider.applyChangeSetGuarded(f.changeSet([
      { operation: 'update', path: 'file.ts', content: 'new', encoding: 'utf-8', expectedHash: hash('old') }
    ]), async () => {}), error => {
      assert.equal((error as { workspaceApplyOutcome?: string }).workspaceApplyOutcome, 'unknown');
      return true;
    });
  } finally {
    fsPromises.writeFile = originalWrite;
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(join(f.root, 'file.ts'), 'utf8'), 'partial');
});

test('replacement of the root after the last authorization cannot redirect the write to another inode', async t => {
  const f = await fixture(t);
  const original = `${f.root}-original`;
  t.after(() => rm(original, { recursive: true, force: true }));
  await writeFile(join(f.root, 'file.ts'), 'old');
  const identity = await lstat(f.root);
  let calls = 0;
  await assert.rejects(f.provider.applyChangeSetGuarded(f.changeSet([
    { operation: 'update', path: 'file.ts', content: 'new', encoding: 'utf-8', expectedHash: hash('old') }
  ]), async () => {
    const current = await lstat(f.root);
    assert.equal(current.ino, identity.ino, 'SOURCE_ROOT_IDENTITY_CHANGED');
    calls += 1;
    if (calls === 3) {
      await rename(f.root, original);
      await mkdir(f.root);
      await writeFile(join(f.root, 'file.ts'), 'old');
    }
  }));
  assert.equal(await readFile(join(f.root, 'file.ts'), 'utf8'), 'old');
});
