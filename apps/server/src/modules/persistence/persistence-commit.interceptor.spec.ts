import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { PersistenceCommitInterceptor } from './persistence-commit.interceptor.js';

function context() {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {}
  } as unknown as ExecutionContext;
}

test('persistence interceptor skips flush for transport-only streams', async () => {
  let flushes = 0;
  const interceptor = new PersistenceCommitInterceptor(
    { flush: async () => { flushes += 1; } } as never,
    { getAllAndOverride: () => true } as never
  );

  assert.equal(await firstValueFrom(interceptor.intercept(context(), { handle: () => of('heartbeat') })), 'heartbeat');
  assert.equal(flushes, 0);
});

test('persistence interceptor still flushes ordinary controller emissions', async () => {
  let flushes = 0;
  const interceptor = new PersistenceCommitInterceptor(
    { flush: async () => { flushes += 1; } } as never,
    { getAllAndOverride: () => false } as never
  );

  assert.equal(await firstValueFrom(interceptor.intercept(context(), { handle: () => of('response') })), 'response');
  assert.equal(flushes, 1);
});
