import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSecrets } from './tool-invocation-audit.service.js';

test('tool invocation audit recursively redacts secrets without removing ordinary arguments', () => {
  assert.deepEqual(redactSecrets({ path:'src/main.ts', nested:{ apiKey:'secret', token_value:'token' }, items:[{ password:'pw', value:1 }] }), {
    path:'src/main.ts', nested:{ apiKey:'[REDACTED]', token_value:'[REDACTED]' }, items:[{ password:'[REDACTED]', value:1 }]
  });
});
