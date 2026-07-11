import assert from 'node:assert/strict';
import test from 'node:test';
import { isGeneratedWorkspacePath } from './is-generated-workspace-path.js';

test('isGeneratedWorkspacePath flags common generated directories', () => {
  assert.equal(isGeneratedWorkspacePath('node_modules/foo/index.js'), true);
  assert.equal(isGeneratedWorkspacePath('dist/main.js'), true);
  assert.equal(isGeneratedWorkspacePath('.next/server/pages.js'), true);
  assert.equal(isGeneratedWorkspacePath('.nuxt/router.ts'), true);
  assert.equal(isGeneratedWorkspacePath('build/output.js'), true);
  assert.equal(isGeneratedWorkspacePath('coverage/lcov.info'), true);
  assert.equal(isGeneratedWorkspacePath('.output/server/index.mjs'), true);
});

test('isGeneratedWorkspacePath flags generated file suffixes anywhere', () => {
  assert.equal(isGeneratedWorkspacePath('src/util.d.ts'), true);
  assert.equal(isGeneratedWorkspacePath('src/util.js.map'), true);
  assert.equal(isGeneratedWorkspacePath('assets/bundle.min.js'), true);
  assert.equal(isGeneratedWorkspacePath('assets/style.min.css'), true);
});

test('isGeneratedWorkspacePath returns false for regular source files', () => {
  assert.equal(isGeneratedWorkspacePath('src/index.ts'), false);
  assert.equal(isGeneratedWorkspacePath('README.md'), false);
  assert.equal(isGeneratedWorkspacePath('apps/server/tsconfig.json'), false);
});
