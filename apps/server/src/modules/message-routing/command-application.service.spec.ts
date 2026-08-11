import assert from 'node:assert/strict';
import test from 'node:test';
import { applyExactCommandResolution } from './command-application.service.js';

test('applies one resolved command action through the domain port', async () => {
  const calls: string[] = [];
  await applyExactCommandResolution({
    resolution: { action: 'resume_session', message: 'resume', confirmationId: 'confirmation-1' },
    port: {
      resume: (confirmationId) => calls.push(`resume:${confirmationId}`),
      retryCurrent: () => calls.push('retry'),
      pause: () => calls.push('pause'),
      cancel: () => calls.push('cancel')
    }
  });
  assert.deepEqual(calls, ['resume:confirmation-1']);
});

test('does not mutate domain state for acknowledgement or clarification', async () => {
  const calls: string[] = [];
  const port = {
    resume: () => calls.push('resume'),
    retryCurrent: () => calls.push('retry'),
    pause: () => calls.push('pause'),
    cancel: () => calls.push('cancel')
  };
  await applyExactCommandResolution({ resolution: { action: 'acknowledge', message: 'running' }, port });
  await applyExactCommandResolution({ resolution: { action: 'clarify', message: 'clarify' }, port });
  assert.deepEqual(calls, []);
});
