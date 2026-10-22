import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WorkspaceChangeSet } from '@agent-cluster/shared';
import { assertIntentSourceChangeSet, type IntentSourceWritePolicy } from './intent-source-write-guard.js';

const original = 'export function login(password: string) { return authenticate(password); }\n';
const guarded = 'export function login(password: string) { if (!password) return false; return authenticate(password); }\n';
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const rejected = /INTENT_SOURCE_CHANGESET_REJECTED/;

function change(content = guarded, path = 'src/login.ts'): WorkspaceChangeSet {
  return { id: 'candidate', createdAt: '2026-10-21T00:00:00.000Z',
    baseRevision: { id: 'base', observedAt: '2026-10-21T00:00:00.000Z' },
    changes: [{ operation: 'update', path, content, encoding: 'utf-8',
      expectedHash: { algorithm: 'sha256', value: hash(original) } }] };
}

async function fixture(run: (policy: IntentSourceWritePolicy) => Promise<void>) {
  const rootPath = await mkdtemp(join(tmpdir(), 'intent-source-guard-'));
  await mkdir(join(rootPath, 'src'));
  await writeFile(join(rootPath, 'src/login.ts'), original);
  try { await run({ rootPath, files: [{ path: 'src/login.ts' }], prohibitions: ['no_schema_change'] }); }
  finally { await rm(rootPath, { recursive: true, force: true }); }
}

async function deniedWithoutMutation(policy: IntentSourceWritePolicy, candidate: WorkspaceChangeSet) {
  const file = join(policy.rootPath, 'src/login.ts');
  const before = hash(await readFile(file));
  await assert.rejects(assertIntentSourceChangeSet(policy, candidate), rejected);
  assert.equal(hash(await readFile(file)), before, 'a rejected candidate must not change a real file');
}

test('source guard accepts only inserted pure parameter guards and never writes the file', async () => {
  await fixture(async policy => {
    await assertIntentSourceChangeSet(policy, change());
    await assertIntentSourceChangeSet(policy, change('export function login(password: string) { if (!password) { return { ok: false, reason: "empty" }; } return authenticate(password); }\n'));
    assert.equal(hash(await readFile(join(policy.rootPath, 'src/login.ts'))), hash(original));
  });
});

test('source guard leaves stale base hash handling to the provider-owned merge', async () => {
  await fixture(async policy => {
    const candidate = change();
    if (candidate.changes[0].operation === 'update') candidate.changes[0].expectedHash.value = hash('old baseline');
    await assertIntentSourceChangeSet(policy, candidate);
  });
});

test('without schema prohibition arbitrary text update is allowed only inside the exact manifest', async () => {
  await fixture(async policy => {
    await assertIntentSourceChangeSet({ ...policy, prohibitions: [] }, change('export const arbitrary = 123;\n'));
    await deniedWithoutMutation({ ...policy, prohibitions: [] }, change('x', 'src/other.ts'));
  });
});

test('source guard rejects changed signatures, existing statements and top-level declarations', async () => {
  await fixture(async policy => {
    for (const content of [
      guarded.replace('password: string', 'password: unknown'),
      guarded.replace('authenticate(password)', 'dangerous(password)'),
      guarded + 'export const schema = "changed";\n',
      guarded.replace('return authenticate(password);', ''),
      guarded.replace('export function', 'export async function'),
      'export const login = (password: string) => false;\n'
    ]) await deniedWithoutMutation(policy, change(content));
  });
});

test('schema proof rejects dynamic SQL, ORM, DDL and unknown changed syntax', async () => {
  await fixture(async policy => {
    for (const content of [
      original.replace('return authenticate(password);', 'db.query(`ALTER TABLE ${password}`); return authenticate(password);'),
      original + 'const User = orm.define("User", { role: DataTypes.STRING });\n',
      original + 'db.exec("CREATE TABLE users(id int)");\n',
      original.replace('return authenticate(password);', 'using resource = db(); return authenticate(password);'),
      original.replace('return authenticate(password);', 'if (password { return false; } return authenticate(password);'),
      original.replace('return authenticate(password);', 'throw new Error("missing"); return authenticate(password);')
    ]) await deniedWithoutMutation(policy, change(content));
  });
});

test('schema guard permits no calls, property reads, assignments, new identifiers or complex returns', async () => {
  await fixture(async policy => {
    for (const guard of [
      'if (validate(password)) return false;', 'if (password.length === 0) return false;',
      'if ((password = "")) return false;', 'if (!unknown) return false;',
      'if (!password) return authenticate(password);', 'if (!password) return { [password]: false };',
      'if (!password) return { get ok() { return false; } };', 'if (!password) return { ...password };',
      'if (!password) { log(); return false; }', 'if (!password) throw "empty";',
      'if (!password) return false; else return true;'
    ]) await deniedWithoutMutation(policy, change(original.replace('{ return', `{ ${guard} return`)));
  });
});

test('schema proof preserves exterior directives and cannot disable an existing strict directive', async () => {
  await fixture(async policy => {
    await deniedWithoutMutation(policy, change('/// <reference path="../../external.ts"/>\n' + guarded));
    const strict = original.replace('{ return', '{ "use strict"; return');
    await writeFile(join(policy.rootPath, 'src/login.ts'), strict);
    await deniedWithoutMutation(policy, change(strict.replace('{ "use strict";', '{ if (!password) return false; "use strict";')));
  });
});

test('schema proof rejects unsupported files and unsupported old declarations rather than guessing', async () => {
  await fixture(async policy => {
    await writeFile(join(policy.rootPath, 'src/query.sql'), 'select 1;');
    await deniedWithoutMutation({ ...policy, files: [...policy.files, { path: 'src/query.sql' }] }, change('select 2;', 'src/query.sql'));
    for (const content of ['export class Model { field = 1; }\n', 'export function* login(password: string) { yield password; }\n']) {
      await writeFile(join(policy.rootPath, 'src/login.ts'), content);
      await deniedWithoutMutation(policy, change(content));
    }
  });
});

test('source guard rejects create, delete, move, base64 and all other encodings', async () => {
  await fixture(async policy => {
    for (const part of [
      { operation: 'create', path: 'src/login.ts', content: 'x', encoding: 'utf-8' },
      { operation: 'delete', path: 'src/login.ts', expectedHash: { algorithm: 'sha256', value: hash(original) } },
      { operation: 'move', fromPath: 'src/login.ts', toPath: 'src/next.ts', expectedHash: { algorithm: 'sha256', value: hash(original) } },
      { ...change().changes[0], encoding: 'base64', content: 'eA==' },
      { ...change().changes[0], encoding: 'utf8' }
    ]) await deniedWithoutMutation(policy, { ...change(), changes: [part] } as WorkspaceChangeSet);
  });
});

test('source guard rejects path traversal, absolute paths, separators, colon and case aliases', async () => {
  await fixture(async policy => {
    for (const path of ['../src/login.ts', 'src/../src/login.ts', '/src/login.ts', 'C:/src/login.ts',
      'src\\login.ts', 'src/login.ts:stream', './src/login.ts', 'src//login.ts', 'SRC/login.ts',
      'src/Login.ts', 'src/login.ts ', 'src/login.ts\0']) await deniedWithoutMutation(policy, change(guarded, path));
    await deniedWithoutMutation({ ...policy, files: [{ path: 'src/Login.ts' }] }, change(guarded, 'src/Login.ts'));
  });
});

test('source guard rejects duplicate updates and duplicate or case-aliased manifest files', async () => {
  await fixture(async policy => {
    await deniedWithoutMutation(policy, { ...change(), changes: [...change().changes, ...change().changes] });
    await deniedWithoutMutation({ ...policy, files: [...policy.files, ...policy.files] }, change());
    await deniedWithoutMutation({ ...policy, files: [...policy.files, { path: 'SRC/LOGIN.TS' }] }, change());
  });
});

test('source guard validates actual bytes with fatal UTF-8 decoding and rejects NUL or surrogate replacement', async () => {
  await fixture(async policy => {
    for (const bytes of [Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0, 97])]) {
      await writeFile(join(policy.rootPath, 'src/login.ts'), bytes);
      await deniedWithoutMutation({ ...policy, prohibitions: [] }, change('valid'));
    }
    await writeFile(join(policy.rootPath, 'src/login.ts'), original);
    for (const content of ['hello\0', '\ud800', '\udc00']) await deniedWithoutMutation({ ...policy, prohibitions: [] }, change(content));
    await assertIntentSourceChangeSet({ ...policy, prohibitions: [] }, change('中文😀'));
  });
});

test('source guard requires existing regular files and bounds file sizes, count and combined payload', async () => {
  await fixture(async policy => {
    await deniedWithoutMutation({ ...policy, files: [{ path: 'src/missing.ts' }] }, change(guarded, 'src/missing.ts'));
    await deniedWithoutMutation({ ...policy, files: [{ path: 'src' }] }, change(guarded, 'src'));
    await deniedWithoutMutation(policy, { ...change(), changes: [] });
    await deniedWithoutMutation(policy, change('x'.repeat(256 * 1024 + 1)));
    await writeFile(join(policy.rootPath, 'src/login.ts'), 'x'.repeat(256 * 1024 + 1));
    await deniedWithoutMutation({ ...policy, prohibitions: [] }, change('x'));
    await writeFile(join(policy.rootPath, 'src/login.ts'), original);
    const parts = [];
    const files = [];
    for (let i = 0; i < 33; i += 1) {
      const path = `src/file-${i}.ts`;
      await writeFile(join(policy.rootPath, path), 'x');
      files.push({ path });
      parts.push({ ...change('x'.repeat(256 * 1024), path).changes[0] });
    }
    await deniedWithoutMutation({ ...policy, prohibitions: [], files }, { ...change(), changes: parts });
    await deniedWithoutMutation({ ...policy, prohibitions: [], files: files.slice(0, 5) }, { ...change(), changes: parts.slice(0, 5) });
  });
});

test('source guard rejects even in-root directory links and a linked root', async t => {
  await fixture(async policy => {
    const alias = join(policy.rootPath, 'alias');
    try { await symlink(join(policy.rootPath, 'src'), alias, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { t.skip(`directory link unavailable: ${(error as NodeJS.ErrnoException).code}`); return; }
    if (!(await lstat(alias)).isSymbolicLink()) { t.skip('host did not create a real link'); return; }
    try {
      await deniedWithoutMutation({ ...policy, files: [{ path: 'alias/login.ts' }] }, change(guarded, 'alias/login.ts'));
      await assert.rejects(assertIntentSourceChangeSet({ ...policy, rootPath: alias, files: [{ path: 'login.ts' }] }, change(guarded, 'login.ts')), rejected);
      await mkdir(join(policy.rootPath, 'src/nested'));
      await writeFile(join(policy.rootPath, 'src/nested/login.ts'), original);
      await assert.rejects(assertIntentSourceChangeSet({ ...policy, rootPath: join(alias, 'nested'), files: [{ path: 'login.ts' }] }, change(guarded, 'login.ts')), rejected);
    } finally { await rm(alias, { force: true }); }
  });
});

test('source guard rejects file symlinks when the host supports creating them', async t => {
  await fixture(async policy => {
    const link = join(policy.rootPath, 'src/link.ts');
    try { await symlink(join(policy.rootPath, 'src/login.ts'), link, 'file'); }
    catch (error) { t.skip(`file symlink unavailable: ${(error as NodeJS.ErrnoException).code}`); return; }
    if (!(await lstat(link)).isSymbolicLink()) { t.skip('host did not create a real symlink'); return; }
    try { await deniedWithoutMutation({ ...policy, files: [{ path: 'src/link.ts' }] }, change(guarded, 'src/link.ts')); }
    finally { await rm(link, { force: true }); }
  });
});
