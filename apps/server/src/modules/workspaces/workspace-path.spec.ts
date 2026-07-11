import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve, sep } from 'node:path';
import { resolveWorkspacePath } from './workspace-path.js';

const root = resolve('/tmp/workspace-root');

test('resolveWorkspacePath returns absolute + relative for a valid nested path', () => {
  const result = resolveWorkspacePath(root, 'src/index.ts');
  assert.equal(result.relative, 'src/index.ts');
  assert.equal(result.absolute, resolve(root, 'src/index.ts'));
});

test('resolveWorkspacePath normalizes backslashes and duplicated separators to POSIX', () => {
  const result = resolveWorkspacePath(root, 'src\\nested\\/file.ts');
  assert.equal(result.relative, 'src/nested/file.ts');
  assert.equal(result.absolute, resolve(root, 'src', 'nested', 'file.ts'));
});

test('resolveWorkspacePath allows the root itself via empty or "." input', () => {
  const dotResult = resolveWorkspacePath(root, '.');
  assert.equal(dotResult.relative, '');
  assert.equal(dotResult.absolute, resolve(root));

  const emptyResult = resolveWorkspacePath(root, '');
  assert.equal(emptyResult.relative, '');
  assert.equal(emptyResult.absolute, resolve(root));
});

test('resolveWorkspacePath rejects absolute POSIX paths', () => {
  assert.throws(() => resolveWorkspacePath(root, '/etc/passwd'), /absolute/i);
});

test('resolveWorkspacePath rejects Windows drive-absolute paths', () => {
  assert.throws(() => resolveWorkspacePath(root, 'C:\\Windows\\System32\\cmd.exe'), /absolute/i);
});

test('resolveWorkspacePath rejects parent traversal via ..', () => {
  assert.throws(() => resolveWorkspacePath(root, '../outside.ts'), /outside|traversal|workspace/i);
});

test('resolveWorkspacePath rejects traversal even when it re-enters via ..', () => {
  assert.throws(
    () => resolveWorkspacePath(root, 'src/../../outside.ts'),
    /outside|traversal|workspace/i
  );
});

test('resolveWorkspacePath returns a path that lives under the workspace root prefix', () => {
  const result = resolveWorkspacePath(root, 'a/b/c.txt');
  assert.ok(result.absolute === resolve(root) || result.absolute.startsWith(resolve(root) + sep));
});
