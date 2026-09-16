import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { APP_URL, normalizeServer, platformKey, isAppUrl, apiTarget, assetPath, validateUpdateUrl } from './policy';

test('platform trust accepts HTTPS or loopback, never remote HTTP/credentials/paths', () => {
  assert.equal(normalizeServer('http://127.0.0.1:8099/'), 'http://127.0.0.1:8099');
  assert.equal(normalizeServer('https://example.com'), 'https://example.com');
  for (const invalid of ['http://example.com', 'file:///C:/data', 'https://name:secret@example.com', 'https://example.com/api', 'https://example.com?token=secret']) {
    assert.throws(() => normalizeServer(invalid));
  }
  assert.equal(platformKey('https://EXAMPLE.com/'), platformKey('https://example.com'));
  assert.notEqual(platformKey('https://example.com'), platformKey('https://other.example.com'));
});
test('proxy is bound to configured origin and blocks definition mutation including encoded bypass', () => {
  const server = 'https://example.com';
  assert.equal(apiTarget(APP_URL + '/api/sessions/s/workflow/select', server, 'POST'), server + '/api/sessions/s/workflow/select');
  assert.equal(apiTarget(APP_URL + '/api/events?after=1', server, 'GET'), server + '/api/events?after=1');
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.throws(() => apiTarget(APP_URL + '/api/workflows/w/versions', server, method));
  }
  for (const path of ['/api/workflows%2Fw', '/api/%252e%252e/private', '/api/workflows%5Cw', '/api/%77orkflows/w', '/api/WORKFLOWS/w']) assert.throws(() => apiTarget(APP_URL + path, server, 'POST'));
  assert.throws(() => apiTarget('https://evil.test/api/events', server, 'GET'));
  assert.throws(() => apiTarget(APP_URL + '/private', server, 'GET'));
});
test('assets allow SPA routes without arbitrary disk reads or foreign origins', () => {
  const root = resolve('fixture-renderer');
  assert.equal(assetPath(root, APP_URL + '/workspace/s'), resolve(root, 'index.html'));
  assert.equal(assetPath(root, APP_URL + '/assets/app.js'), resolve(root, 'assets/app.js'));
  assert.throws(() => assetPath(root, APP_URL + '/..%2f..%2fsecret.txt'));
  assert.throws(() => assetPath(root, APP_URL + '/%5csecret.txt'));
  assert.equal(isAppUrl('agent-cluster://app.evil/workspace'), false);
  assert.equal(isAppUrl('agent-cluster://user@app/workspace'), false);
});
test('update feed requires an uncredentialed HTTPS publication endpoint', () => {
  assert.equal(validateUpdateUrl('https://updates.example.com/windows/'), 'https://updates.example.com/windows/');
  for (const url of ['http://updates.example.com', 'https://secret@updates.example.com', 'https://updates.example.com?token=x']) assert.throws(() => validateUpdateUrl(url));
});
