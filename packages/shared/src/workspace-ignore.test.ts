import test from 'node:test';
import assert from 'node:assert/strict';
import { isGeneratedWorkspaceDirectory } from './workspace-ignore.js';

test('generated workspace directory ignore rules include common framework build folders', () => {
  for (const name of ['.nuxt', '.output', '.vite', '.turbo']) {
    assert.equal(isGeneratedWorkspaceDirectory(name), true, `${name} should be ignored`);
  }
});

test('generated workspace directory ignore rules do not ignore source folders', () => {
  for (const name of ['src', 'apps', 'packages']) {
    assert.equal(isGeneratedWorkspaceDirectory(name), false, `${name} should not be ignored`);
  }
});
