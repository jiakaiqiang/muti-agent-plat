import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeSecret, encodeSecret, isEncodedSecret } from './secret-cipher.js';

const MASTER_KEY = 'test-only-master-key-with-enough-entropy';

test('encodeSecret never exposes the credential in its envelope', () => {
  const credential = 'sk-live-abcdef1234567890';
  const envelope = encodeSecret(credential, MASTER_KEY);
  assert.notEqual(envelope, credential);
  assert.equal(envelope.includes(credential), false);
  assert.equal(envelope.includes('abcdef1234567890'), false);
});

test('enc-v2 round-trips with the matching master key', () => {
  const envelope = encodeSecret('sk-live-abcdef1234567890', MASTER_KEY);
  assert.equal(decodeSecret(envelope, MASTER_KEY), 'sk-live-abcdef1234567890');
});

test('encoded secret detection accepts only enc-v2', () => {
  assert.equal(isEncodedSecret(encodeSecret('key', MASTER_KEY)), true);
  assert.equal(isEncodedSecret('plain-value'), false);
  assert.equal(isEncodedSecret('enc-v1:salt:value'), false);
});

test('decodeSecret rejects plaintext persisted credentials', () => {
  assert.throws(() => decodeSecret('sk-plain', MASTER_KEY), /enc-v2/);
});

test('decodeSecret rejects enc-v1 persisted credentials', () => {
  assert.throws(() => decodeSecret('enc-v1:salt:value', MASTER_KEY), /enc-v2/);
});

test('encodeSecret supports an empty value', () => {
  assert.equal(decodeSecret(encodeSecret('', MASTER_KEY), MASTER_KEY), '');
});

test('encodeSecret supports Unicode credentials', () => {
  const credential = '中文密钥';
  assert.equal(decodeSecret(encodeSecret(credential, MASTER_KEY), MASTER_KEY), credential);
});

test('decodeSecret rejects a wrong master key', () => {
  const envelope = encodeSecret('secret', MASTER_KEY);
  assert.throws(() => decodeSecret(envelope, 'wrong-key'));
});

test('encodeSecret and decodeSecret require a master key', () => {
  const envelope = encodeSecret('secret', MASTER_KEY);
  assert.throws(() => encodeSecret('secret', ''), /AGENT_CLUSTER_SECRET_KEY/);
  assert.throws(() => decodeSecret(envelope, ''), /AGENT_CLUSTER_SECRET_KEY/);
});

test('decodeSecret rejects malformed enc-v2 envelopes', () => {
  assert.throws(() => decodeSecret('enc-v2:too:few:parts', MASTER_KEY), /Invalid enc-v2/);
});
