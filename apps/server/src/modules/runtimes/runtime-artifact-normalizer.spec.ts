import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRuntimeArtifact } from './runtime-artifact-normalizer.js';

test('promotes legacy metadata.content to top-level Artifact content', () => {
  const legacy = {
    type: 'markdown',
    title: '项目架构分析报告',
    metadata: {
      content: '# 项目架构\n\n正文',
      reportKind: 'project_architecture_analysis'
    }
  };

  const normalized = normalizeRuntimeArtifact(legacy);

  assert.deepEqual(normalized, {
    type: 'markdown',
    title: '项目架构分析报告',
    content: '# 项目架构\n\n正文',
    metadata: { reportKind: 'project_architecture_analysis' }
  });
  assert.equal(legacy.metadata.content, '# 项目架构\n\n正文');
});

test('keeps canonical top-level content and removes duplicate metadata.content', () => {
  const normalized = normalizeRuntimeArtifact({
    type: 'markdown',
    title: 'Canonical report',
    content: '# Canonical body',
    metadata: { content: '# Legacy body', source: 'model' }
  });

  assert.deepEqual(normalized, {
    type: 'markdown',
    title: 'Canonical report',
    content: '# Canonical body',
    metadata: { source: 'model' }
  });
});

test('rejects legacy Artifact without any usable body', () => {
  assert.equal(
    normalizeRuntimeArtifact({ type: 'markdown', title: 'Missing body', metadata: { content: '' } }),
    undefined
  );
});

test('maps legacy architecture_analysis type to canonical markdown', () => {
  assert.deepEqual(
    normalizeRuntimeArtifact({
      type: 'architecture_analysis',
      title: 'Architecture report',
      content: '# Architecture'
    }),
    {
      type: 'markdown',
      title: 'Architecture report',
      content: '# Architecture'
    }
  );
});

test('rejects unknown Artifact types without an explicit mapping', () => {
  assert.equal(
    normalizeRuntimeArtifact({ type: 'mystery_report', title: 'Mystery', content: 'Unknown body' }),
    undefined
  );
});
