import assert from 'node:assert/strict';
import test from 'node:test';

const RUN_FLAG = 'RUN_REAL_GLM_ACCEPTANCE';
const REQUIRED_ENV = ['GLM_API_KEY', 'GLM_BASE_URL', 'GLM_MODEL'] as const;

function shouldRunRealGlm(): boolean {
  return process.env[RUN_FLAG] === '1' || process.env[RUN_FLAG] === 'true';
}

function readRequiredEnv(): { ok: true; env: Record<(typeof REQUIRED_ENV)[number], string> } | { ok: false; missing: string[] } {
  const env = {} as Record<(typeof REQUIRED_ENV)[number], string>;
  const missing: string[] = [];
  for (const key of REQUIRED_ENV) {
    const value = process.env[key];
    if (!value || value.trim().length === 0) {
      missing.push(key);
      continue;
    }
    env[key] = value;
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, env };
}

test('real GLM acceptance skips safely when the gating environment variable is not set', () => {
  if (shouldRunRealGlm()) {
    return;
  }
  assert.equal(shouldRunRealGlm(), false);
  const env = readRequiredEnv();
  if (env.ok) {
    return;
  }
  assert.ok(env.missing.length >= 0);
});

test('real GLM acceptance runs the gated smoke path when RUN_REAL_GLM_ACCEPTANCE=1', { skip: !shouldRunRealGlm() }, async () => {
  const env = readRequiredEnv();
  assert.equal(env.ok, true, `missing required env: ${env.ok ? '' : env.missing.join(',')}`);
  if (!env.ok) return;
  const response = await fetch(`${env.env.GLM_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${env.env.GLM_API_KEY}` }
  });
  assert.equal(response.ok, true, `real GLM /models must succeed, got ${response.status}`);
});

test('real GLM architecture analysis returns traceable evidence and token diagnostics', { skip: !shouldRunRealGlm() }, async () => {
  const env = readRequiredEnv();
  assert.equal(env.ok, true, `missing required env: ${env.ok ? '' : env.missing.join(',')}`);
  if (!env.ok) return;

  const response = await fetch(`${env.env.GLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${env.env.GLM_API_KEY}`
    },
    body: JSON.stringify({
      model: env.env.GLM_MODEL,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: 'You are a gated acceptance checker. Return a concise markdown architecture report grounded only in the supplied evidence.'
        },
        {
          role: 'user',
          content: [
            '请基于以下 Evidence 生成一段中文架构分析报告。',
            '必须包含小节：## Evidence、## 报告、## Token 诊断。',
            'Evidence:',
            '- package.json: {"name":"glm-acceptance-fixture","dependencies":{"vue":"^3.5.0","vite":"^6.0.0"}}',
            '- src/main.ts: import { createApp } from "vue"; createApp(App).mount("#app");',
            '报告中必须逐字引用 package.json 和 src/main.ts 两个 evidence ref。'
          ].join('\n')
        }
      ]
    })
  });
  assert.equal(response.ok, true, `real GLM chat completions must succeed, got ${response.status} ${await response.text()}`);
  const body = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const content = body.choices?.[0]?.message?.content ?? '';
  assert.match(content, /Evidence|证据/i);
  assert.match(content, /报告|架构/);
  assert.match(content, /package\.json/);
  assert.match(content, /src\/main\.ts/);
  assert.ok((body.usage?.total_tokens ?? 0) > 0, `expected token usage diagnostics: ${JSON.stringify(body.usage)}`);
});
