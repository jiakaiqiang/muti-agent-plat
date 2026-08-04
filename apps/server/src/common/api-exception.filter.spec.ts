import assert from 'node:assert/strict';
import test from 'node:test';
import { ConflictException } from '@nestjs/common';
import { ApiExceptionFilter } from './api-exception.filter.js';

test('API exception filter preserves structured conflict details', () => {
  let status = 0;
  let body: unknown;
  const host = {
    switchToHttp() {
      return {
        getResponse() {
          return {
            status(value: number) {
              status = value;
              return { json(valueBody: unknown) { body = valueBody; } };
            }
          };
        }
      };
    }
  };
  new ApiExceptionFilter().catch(new ConflictException({
    code: 'SESSION_DELETE_CONFLICT',
    message: 'Session cleanup did not finish.',
    sessionId: 'session-1',
    pendingInvocationIds: ['invocation-1']
  }), host as never);

  assert.equal(status, 409);
  assert.deepEqual((body as { error: unknown }).error, {
    code: 'SESSION_DELETE_CONFLICT',
    message: 'Session cleanup did not finish.',
    details: {
      sessionId: 'session-1',
      pendingInvocationIds: ['invocation-1']
    }
  });
});
