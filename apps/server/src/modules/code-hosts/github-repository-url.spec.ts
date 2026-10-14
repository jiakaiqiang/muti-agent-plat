import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGitHubRepositoryUrl } from './github-repository-url.js';

test('normalizes the supported GitHub HTTPS repository forms', () => {
  assert.deepEqual(normalizeGitHubRepositoryUrl('https://GitHub.com/Example/Project.git'), {
    provider: 'github', owner: 'example', repository: 'project',
    repositoryId: 'example/project', repositoryUrl: 'https://github.com/example/project'
  });
  assert.equal(normalizeGitHubRepositoryUrl('https://github.com/example/project/').repositoryId, 'example/project');
});

test('rejects credentials, foreign hosts and ambiguous repository URLs', () => {
  for (const value of [
    'https://token@github.com/example/project',
    'https://github.com.evil.test/example/project',
    'http://github.com/example/project',
    'https://github.com/example/project?token=secret',
    'https://github.com/example/project/tree/main',
    'https://github.com/example/%2e%2e',
    'git@github.com:example/project.git'
  ]) {
    assert.throws(() => normalizeGitHubRepositoryUrl(value), /GITHUB_REPOSITORY_URL_INVALID/);
  }
});
