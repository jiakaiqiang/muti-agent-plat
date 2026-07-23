import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

test('shared contracts do not expose the superseded RuntimeRoutingInput family', () => {
  assert.doesNotMatch(read('packages/shared/src/contracts.ts'), /RuntimeRoutingInput|RuntimeRoutingOverride/);
});

test('shared contracts contain no Agent-preferred or userOverride routing inputs', () => {
  assert.doesNotMatch(read('packages/shared/src/contracts.ts'), /agentPreferredRuntime|userOverride/);
});

test('the obsolete shared RuntimeRoutingInput contract test is removed', () => {
  assert.equal(existsSync(resolve(root, 'packages/shared/src/runtime-routing-input.contract.test.ts')), false);
});

test('runtime config uses invocation-neutral names and environment variables', () => {
  assert.doesNotMatch(read('apps/server/src/common/runtime-config.ts'), /EngineeringRuntime|ENGINEERING_RUNTIME/);
});

test('Orchestrator does not import engineering-specific routing defaults', () => {
  assert.doesNotMatch(read('apps/server/src/modules/orchestrator/orchestrator.service.ts'), /defaultEngineeringRuntimeType|projectDefaultEngineeringRuntimeType/);
});

test('Runtime adapters expose streaming or buffered modes without a legacy branch label', () => {
  const source = [
    read('apps/server/src/modules/runtimes/codex-runtime-adapter.service.ts'),
    read('apps/server/src/modules/runtimes/claude-code-runtime-adapter.service.ts'),
    read('apps/server/src/modules/runtimes/runtime.service.ts')
  ].join('\n');
  assert.doesNotMatch(source, /engineeringRuntimeStreaming|ENGINEERING_RUNTIME_STREAMING|['"]legacy['"]/);
});

test('environment examples contain no engineering-specific Runtime compatibility variables', () => {
  assert.doesNotMatch(read('.env.example'), /ENGINEERING_RUNTIME/);
});

test('secret cipher recognizes only authenticated enc-v2 envelopes', () => {
  const source = read('apps/server/src/common/secret-cipher.ts');
  assert.doesNotMatch(source, /enc-v1|decodeLegacy|deriveLegacy|createHash/);
});

test('secret decoding has no plaintext pass-through behavior', () => {
  const source = read('apps/server/src/common/secret-cipher.ts');
  assert.doesNotMatch(source, /return value;|not encoded|plaintext pass/i);
});

test('secret tests do not preserve plaintext or v1 decoding success', () => {
  assert.doesNotMatch(read('apps/server/src/common/secret-cipher.spec.ts'), /legacy plaintext|unchanged when it is not|equal\(decodeSecret\('enc-v1/);
});

test('root scripts expose no ActorRef backfill, engineering selection, or historical session resume commands', () => {
  assert.doesNotMatch(read('package.json'), /actor-ref-postgres-backfill|engineering-runtime-selection|session-resumption/);
});

test('v2-only E2E uses a target-named file instead of the old isolation smoke script', () => {
  const packageSource = read('package.json');
  assert.doesNotMatch(packageSource, /context-pipeline-isolation/);
  assert.equal(existsSync(resolve(root, 'tests/e2e/context-pipeline-isolation-smoke.mjs')), false);
});

test('dynamic routing audit exercises InvocationResolver instead of the deleted selector', () => {
  const source = read('tests/e2e/dynamic-runtime-routing-audit.spec.ts');
  assert.match(source, /InvocationResolverService/);
  assert.doesNotMatch(source, /RuntimeRoutingInput|resolveExecutionTarget|agentPreferredRuntime|userOverride/);
});
