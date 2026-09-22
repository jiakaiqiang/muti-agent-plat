import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildPhase6LiveModelEvidence, calculateWorstCaseCost, runPhase6LiveModelEvaluation } from '../../scripts/phase-6-live-model-evaluation.mjs';

const root = resolve(import.meta.dirname, '../..');
const execFileAsync = promisify(execFile);

test('worst-case cost includes input, cache-write, output, and call ceilings', () => {
  const result = calculateWorstCaseCost({
    pricing: {
      inputPerMillion: 1,
      outputPerMillion: 4,
      cacheReadInputPerMillion: 0.5,
      cacheWriteInputPerMillion: 2
    },
    calls: 5,
    maxInputTokens: 1_000,
    maxOutputTokens: 100
  });
  assert.equal(result.perCall, 0.0034);
  assert.ok(Math.abs(result.total - 0.017) < 1e-12);
});

test('absent provider cache counters remain unknown rather than zero', () => {
  const evidence = buildPhase6LiveModelEvidence({
    startedAt: '2026-09-20T00:00:00.000Z',
    completedAt: '2026-09-20T00:00:01.000Z',
    worstCase: { total: 0.1 },
    providerRequestCount: 1,
    results: [{
      id: 'early_requirement_recall', status: 'completed', assessmentPassed: true,
      usage: { inputTokens: 100, outputTokens: 20, cost: 0.001 },
      streamMetrics: { firstFrameLatencyMs: 10, durationMs: 20 }
    }]
  });
  assert.equal(evidence.aggregate.cacheReadTokens, null);
  assert.equal(evidence.aggregate.cacheWriteTokens, null);
});

test('live-model runner uses RuntimeService, records sanitized metrics, and never reaches an external provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phase-6-live-eval-'));
  const evidencePath = join(directory, 'evidence.json');
  let chatCalls = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    chatCalls += 1;
    const body = await readRequest(request);
    const requestBody = JSON.parse(body);
    assert.deepEqual(requestBody.stream_options, { include_usage: true });
    const marker = body.includes('EARLY-REQ-ALPHA')
      ? 'EARLY-REQ-ALPHA'
      : body.includes('CLARIFICATION_REQUIRED')
        ? 'CLARIFICATION_REQUIRED'
        : body.includes('ACTIVE_FORMAT_JSON')
          ? 'ACTIVE_FORMAT_JSON'
          : 'CACHE-PROBE-OMEGA';
    const output = JSON.stringify({
      schemaVersion: '1.0',
      kind: 'agent_message',
      messageKind: 'answer',
      content: marker,
      targetAgentIds: [],
      targetAgentKeys: [],
      mentionedAgentIds: [],
      relatedTaskIds: []
    });
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: chatCalls === 5 ? 80 : 0 },
      cache_creation_input_tokens: 0
    };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: output } }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const connectionId = `remote:openai-compatible:server:http-127-0-0-1-${address.port}-v1:fixture-model`;
  const env = {
    ...process.env,
    PHASE_6_LIVE_MODEL_APPROVAL_ID: 'test-approval-secret',
    PHASE_6_LIVE_MODEL_DATA_SCOPE: 'synthetic_fixture_only',
    PHASE_6_LIVE_MODEL_MAX_CALLS: '5',
    PHASE_6_LIVE_MODEL_MAX_COST_USD: '1',
    PHASE_6_LIVE_MODEL_CONNECTION_ID: connectionId,
    PHASE_6_LIVE_MODEL_EVIDENCE_PATH: evidencePath,
    LLM_PROVIDER: 'openai-compatible',
    LLM_BASE_URL: baseUrl,
    LLM_API_KEY: 'fake-secret-key',
    LLM_MODEL: 'fixture-model',
    LLM_MOCK_FALLBACK: 'false',
    AGENT_CLUSTER_RUNTIME_PRICING_JSON: JSON.stringify({
      priceVersion: 'fixture-pricing-v1',
      currency: 'USD',
      entries: [{ connectionId, inputPerMillion: 1, outputPerMillion: 2, cacheReadInputPerMillion: 0.25 }]
    })
  };

  try {
    const outcome = await runPhase6LiveModelEvaluation({ env });
    assert.equal(outcome.result, 'completed', JSON.stringify(outcome));
    assert.equal(chatCalls, 5);
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    assert.equal(evidence.status, 'completed');
    assert.equal(evidence.aggregate.completedCalls, 5);
    assert.equal(evidence.aggregate.failedCalls, 0);
    assert.equal(evidence.aggregate.qualityPassed, 5);
    assert.equal(evidence.aggregate.cacheReadTokens, 80);
    assert.equal(evidence.aggregate.cacheWriteTokens, 0);
    assert.ok(evidence.aggregate.totalCostUsd > 0);
    assert.ok(evidence.scenarios.every((item) => Number.isFinite(item.streamMetrics.firstFrameLatencyMs)));
    const serialized = JSON.stringify(evidence);
    assert.equal(serialized.includes('fake-secret-key'), false);
    assert.equal(serialized.includes('test-approval-secret'), false);
    assert.equal(serialized.includes(baseUrl), false);
    assert.equal(serialized.includes(connectionId), false);
    assert.equal(serialized.includes('EARLY-REQ-ALPHA'), false);
    const reportPath = join(directory, 'report.md');
    await execFileAsync(process.execPath, ['scripts/phase-6-cost-report.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        PHASE_6_LIVE_MODEL_EVIDENCE_PATH: evidencePath,
        PHASE_6_COST_REPORT_PATH: reportPath
      }
    });
    const report = await readFile(reportPath, 'utf8');
    assert.match(report, /受批真实模型抽样/);
    assert.match(report, /5\/5/);
    assert.match(report, /平均 TTFT/);
    assert.equal(report.includes('fake-secret-key'), false);
    assert.equal(report.includes('EARLY-REQ-ALPHA'), false);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  }
});

test('live-model runner blocks before networking when the cost ceiling is too low', async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(500).end();
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const connectionId = `remote:openai-compatible:server:http-127-0-0-1-${address.port}-v1:fixture-model`;
  try {
    const outcome = await runPhase6LiveModelEvaluation({ env: {
      ...process.env,
      PHASE_6_LIVE_MODEL_APPROVAL_ID: 'test-approval-secret',
      PHASE_6_LIVE_MODEL_DATA_SCOPE: 'synthetic_fixture_only',
      PHASE_6_LIVE_MODEL_MAX_CALLS: '5',
      PHASE_6_LIVE_MODEL_MAX_COST_USD: '0.000001',
      PHASE_6_LIVE_MODEL_CONNECTION_ID: connectionId,
      LLM_PROVIDER: 'openai-compatible',
      LLM_BASE_URL: baseUrl,
      LLM_API_KEY: 'fake-secret-key',
      LLM_MODEL: 'fixture-model',
      LLM_MOCK_FALLBACK: 'false',
      AGENT_CLUSTER_RUNTIME_PRICING_JSON: JSON.stringify({
        priceVersion: 'fixture-pricing-v1',
        currency: 'USD',
        entries: [{ connectionId, inputPerMillion: 10, outputPerMillion: 20 }]
      })
    } });
    assert.equal(outcome.result, 'blocked');
    assert.equal(outcome.reason, 'worst_case_cost_exceeds_approved_limit');
    assert.equal(requests, 0);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test('live-model runner rejects provider redirects outside the approved endpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phase-6-live-redirect-'));
  let redirectedRequests = 0;
  const unapproved = createServer((_request, response) => {
    redirectedRequests += 1;
    response.writeHead(200).end();
  });
  await new Promise((resolveListen) => unapproved.listen(0, '127.0.0.1', resolveListen));
  const unapprovedAddress = unapproved.address();
  assert.equal(typeof unapprovedAddress, 'object');
  const provider = createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
      return;
    }
    response.writeHead(302, { location: `http://127.0.0.1:${unapprovedAddress.port}/leak` }).end();
  });
  await new Promise((resolveListen) => provider.listen(0, '127.0.0.1', resolveListen));
  const address = provider.address();
  assert.equal(typeof address, 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const connectionId = `remote:openai-compatible:server:http-127-0-0-1-${address.port}-v1:fixture-model`;
  const evidencePath = join(directory, 'evidence.json');
  try {
    const outcome = await runPhase6LiveModelEvaluation({ env: {
      ...process.env,
      PHASE_6_LIVE_MODEL_APPROVAL_ID: 'test-approval-secret',
      PHASE_6_LIVE_MODEL_DATA_SCOPE: 'synthetic_fixture_only',
      PHASE_6_LIVE_MODEL_MAX_CALLS: '5',
      PHASE_6_LIVE_MODEL_MAX_COST_USD: '1',
      PHASE_6_LIVE_MODEL_CONNECTION_ID: connectionId,
      LLM_PROVIDER: 'openai-compatible',
      LLM_BASE_URL: baseUrl,
      LLM_API_KEY: 'fake-secret-key',
      LLM_MODEL: 'fixture-model',
      LLM_MOCK_FALLBACK: 'false',
      AGENT_CLUSTER_RUNTIME_PRICING_JSON: JSON.stringify({
        priceVersion: 'fixture-pricing-v1',
        currency: 'USD',
        entries: [{ connectionId, inputPerMillion: 1, outputPerMillion: 2 }]
      })
    }, evidencePath });
    assert.equal(outcome.result, 'failed');
    assert.equal(outcome.evidence.status, 'failed');
    assert.equal(outcome.evidence.providerRequestCount, 1);
    assert.equal(redirectedRequests, 0);
    assert.equal(JSON.stringify(outcome.evidence).includes('fake-secret-key'), false);
  } finally {
    await new Promise((resolveClose) => provider.close(resolveClose));
    await new Promise((resolveClose) => unapproved.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  }
});

function readRequest(request) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolveBody(body));
    request.on('error', reject);
  });
}
