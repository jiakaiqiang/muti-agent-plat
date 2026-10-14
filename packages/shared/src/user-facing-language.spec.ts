import assert from 'node:assert/strict';
import test from 'node:test';
import { CHINESE_RUNTIME_OUTPUT_INSTRUCTION, localizeBuiltInNotice, localizeSystemError, runtimePhaseLabel } from './user-facing-language.js';
import { buildStructuredOutputInstructions, RUNTIME_OUTPUT_KINDS } from './runtime-contracts/index.js';

test('every model output kind requires Chinese human language without translating the protocol', () => {
  for (const kind of RUNTIME_OUTPUT_KINDS) {
    assert.ok(buildStructuredOutputInstructions(kind).includes(CHINESE_RUNTIME_OUTPUT_INSTRUCTION), kind);
  }
  assert.match(CHINESE_RUNTIME_OUTPUT_INSTRUCTION, /requestedContext.reason 和 followUpInstruction/);
  assert.match(CHINESE_RUNTIME_OUTPUT_INSTRUCTION, /JSON 字段名、枚举值和错误码保持原样/);
  assert.equal(runtimePhaseLabel('task_execution'), '任务执行');
});

test('historical evidence notices and instructions have deterministic Chinese presentation', () => {
  const original = 'Supplemental context hydrated for retry: Context v2 blocked an ungrounded runtime call: evidence-empty.';
  const localized = localizeBuiltInNotice(original);
  assert.match(localized, /已补充上下文，准备重试/);
  assert.match(localized, /尚未提供可用的源码内容/);
  assert.match(localized, /evidence-empty/);
  assert.equal(localizeBuiltInNotice(localized), localized);
  for (const reason of ['evidence-empty', 'evidence-only-generated', 'evidence-only-sensitive', 'evidence-not-navigable']) {
    assert.match(localizeBuiltInNotice(`Context v2 blocked an ungrounded runtime call: ${reason}.`), /上下文证据不足/);
  }
  assert.match(localizeBuiltInNotice('Read at least one non-sensitive source file and retry the same phase.'), /请至少读取/);
});

test('unknown prose and code are not translated as built-in notices', () => {
  for (const text of ['Please inspect game.js', 'const msg = "Context v2 blocked an ungrounded runtime call: evidence-empty.";', '用户原文', 'Task completed.']) {
    assert.equal(localizeBuiltInNotice(text), text);
  }
});

test('system failures have Chinese explanations and stable diagnostics', () => {
  assert.match(localizeSystemError('GITHUB_APP_OAUTH_NOT_CONFIGURED'), /平台尚未配置 GitHub App/);
  assert.match(localizeSystemError('GITHUB_APP_OAUTH_NOT_CONFIGURED'), /GITHUB_APP_OAUTH_NOT_CONFIGURED/);
  assert.match(localizeSystemError('AGENT_CLUSTER_SECRET_KEY is required to persist runtime credentials securely.', 'INTERNAL_ERROR'), /凭据加密密钥/);
  assert.match(localizeSystemError('GITHUB_API_HTTP_401', 'INTERNAL_ERROR'), /身份验证失败/);
  assert.match(localizeSystemError('Failed to fetch'), /连接服务失败/);
  assert.equal(localizeSystemError('请补充需求', 'VALIDATION_ERROR'), '请补充需求');
  assert.match(localizeSystemError('Opaque failure', 'NEW_DIAGNOSTIC'), /操作未完成.*NEW_DIAGNOSTIC/);
});
