import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceSnapshot } from '@agent-cluster/shared';
import { IntentRecognitionService } from './intent-recognition.service.js';

const service = new IntentRecognitionService();

function workspaceSnapshot(): WorkspaceSnapshot {
  return {
    rootName: 'demo',
    scannedAt: '2026-07-06T00:00:00.000Z',
    fileCount: 1,
    totalBytes: 128,
    tree: [{ path: 'src', kind: 'directory', children: [{ path: 'src/main.ts', kind: 'file' }] }],
    files: [{ path: 'src/main.ts', size: 128, language: 'typescript', content: 'export const main = true;' }],
    skipped: [],
    detectedStack: ['typescript'],
    entrypoints: ['src/main.ts']
  };
}

test('recognizes task domain and intent from workspace-aware project analysis input', () => {
  const result = service.recognizeTask('分析当前项目架构并说明主链路', workspaceSnapshot());

  assert.equal(result.domain, 'mixed');
  assert.equal(result.intent, 'analysis');
});

test('recognizes the exact project architecture viewing request as analysis', () => {
  const result = service.recognizeTask('查看当前项目的架构', workspaceSnapshot());

  assert.equal(result.intent, 'analysis');
  assert.equal(result.requiresCodeChanges, false);
});

test('recognizes viewing, introduction, familiarization, and architecture phrasing as analysis', () => {
  for (const input of ['查看项目模块', '介绍一下这个工程', '熟悉当前代码库', '梳理系统架构']) {
    assert.equal(service.recognizeTask(input, workspaceSnapshot()).intent, 'analysis', input);
  }
});

test('recognizes implementation requests as coding tasks', () => {
  const result = service.recognizeTask('实现一个登录接口');

  assert.equal(result.domain, 'coding');
  assert.equal(result.intent, 'implementation');
  assert.equal(result.requiresCodeChanges, true);
});

test('recognizes executing constraints as high-priority pauses', () => {
  const result = service.recognizeUserMessage('不要修改源码', 'EXECUTING');

  assert.equal(result.intent, 'constraint');
  assert.equal(result.priority, 'high');
  assert.equal(result.shouldPause, true);
  assert.equal(result.requiresBriefRevision, false);
  assert.match(result.coordinatorInstruction, /新增约束/);
});

test('recognizes pre-execution constraints as brief revision signals', () => {
  const result = service.recognizeUserMessage('补充约束：不要生成测试任务', 'WAIT_USER_CONFIRM');

  assert.equal(result.intent, 'constraint');
  assert.equal(result.priority, 'high');
  assert.equal(result.shouldPause, false);
  assert.equal(result.requiresBriefRevision, true);
});

test('recognizes user questions without forcing a pause', () => {
  const result = service.recognizeUserMessage('为什么会阻塞？', 'WAIT_USER_DECISION');

  assert.equal(result.intent, 'question');
  assert.equal(result.priority, 'normal');
  assert.equal(result.shouldPause, false);
  assert.equal(result.requiresBriefRevision, false);
});
