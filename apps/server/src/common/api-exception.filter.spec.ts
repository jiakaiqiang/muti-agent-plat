import assert from 'node:assert/strict';
import test from 'node:test';
import { ConflictException } from '@nestjs/common';
import { ApiExceptionFilter } from './api-exception.filter.js';

test('API exception filter preserves structured workspace conflict details', () => {
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
    code: 'WORKSPACE_ACTIVE_SESSION_CONFLICT',
    message: 'Workspace already has an active Session.',
    workspaceId: 'workspace-1',
    activeSessionId: 'session-1',
    activeSessionStatus: 'EXECUTING'
  }), host as never);

  assert.equal(status, 409);
  assert.deepEqual((body as { error: unknown }).error, {
    code: 'WORKSPACE_ACTIVE_SESSION_CONFLICT',
    message: 'Workspace already has an active Session.',
    details: {
      workspaceId: 'workspace-1',
      activeSessionId: 'session-1',
      activeSessionStatus: 'EXECUTING'
    }
  });
});
