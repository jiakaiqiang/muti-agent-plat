import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeBrowserWorkspacePath,
  isSensitiveBrowserWorkspacePath,
  normalizeBrowserWorkspacePath
} from './workspaceBrokerPath';

test('normalizeBrowserWorkspacePath returns empty string for root shortcuts', () => {
  assert.equal(normalizeBrowserWorkspacePath(''), '');
  assert.equal(normalizeBrowserWorkspacePath('.'), '');
  assert.equal(normalizeBrowserWorkspacePath('./'), '');
});

test('normalizeBrowserWorkspacePath converts backslashes and collapses redundant separators', () => {
  assert.equal(normalizeBrowserWorkspacePath('src\\app.ts'), 'src/app.ts');
  assert.equal(normalizeBrowserWorkspacePath('src//app.ts'), 'src/app.ts');
  assert.equal(normalizeBrowserWorkspacePath('src/./app.ts'), 'src/app.ts');
  assert.equal(normalizeBrowserWorkspacePath('src/app.ts/'), 'src/app.ts');
});

test('normalizeBrowserWorkspacePath rejects .. traversal in any position', () => {
  assert.throws(() => normalizeBrowserWorkspacePath('../secret'), /traversal/i);
  assert.throws(() => normalizeBrowserWorkspacePath('src/../etc/passwd'), /traversal/i);
  assert.throws(() => normalizeBrowserWorkspacePath('src/..'), /traversal/i);
  assert.throws(() => normalizeBrowserWorkspacePath('..\\secret'), /traversal/i);
  assert.throws(() => normalizeBrowserWorkspacePath('a/b/..\\..\\etc'), /traversal/i);
});

test('normalizeBrowserWorkspacePath rejects absolute-style paths', () => {
  assert.throws(() => normalizeBrowserWorkspacePath('/etc/passwd'), /absolute|leading/i);
  assert.throws(() => normalizeBrowserWorkspacePath('C:/Windows'), /absolute|drive/i);
  assert.throws(() => normalizeBrowserWorkspacePath('C:\\Windows'), /absolute|drive/i);
});

test('browser workspace path policy rejects sensitive credentials and keys', () => {
  assert.equal(isSensitiveBrowserWorkspacePath('.env.local'), true);
  assert.equal(isSensitiveBrowserWorkspacePath('config/service.pem'), true);
  assert.equal(isSensitiveBrowserWorkspacePath('.ssh/config'), true);
  assert.equal(isSensitiveBrowserWorkspacePath('src/app.ts'), false);
  assert.throws(() => assertSafeBrowserWorkspacePath('.aws/credentials'), /sensitive/i);
});
