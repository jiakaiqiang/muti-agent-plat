import assert from 'node:assert/strict';
import test from 'node:test';
import { CacheSingleFlight } from './cache-single-flight.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('concurrent requests for one key run a single build', async () => {
  const flight = new CacheSingleFlight<string>();
  const gate = deferred<string>();
  let builds = 0;

  const callers = Array.from({ length: 100 }, () =>
    flight.run('key-1', async () => {
      builds += 1;
      return gate.promise;
    })
  );

  gate.resolve('built');
  const results = await Promise.all(callers);

  assert.equal(builds, 1, 'a hundred identical requests must not trigger a hundred builds');
  assert.deepEqual(new Set(results.map((r) => (r.status === 'built' ? r.value : r.status))), new Set(['built']));
});

test('a build joined by others is reported as joined, not rebuilt', async () => {
  const flight = new CacheSingleFlight<string>();
  const gate = deferred<string>();

  const first = flight.run('key-1', async () => gate.promise);
  const second = flight.run('key-1', async () => gate.promise);

  gate.resolve('built');
  const [a, b] = await Promise.all([first, second]);

  assert.equal(a.status, 'built');
  assert.equal(b.status, 'built');
  assert.equal(a.owner, true, 'exactly one caller owns the build');
  assert.equal(b.owner, false, 'the joiner did not build and must not backfill as owner');
});

test('different keys build independently', async () => {
  const flight = new CacheSingleFlight<string>();
  let builds = 0;

  await Promise.all([
    flight.run('key-1', async () => {
      builds += 1;
      return 'a';
    }),
    flight.run('key-2', async () => {
      builds += 1;
      return 'b';
    })
  ]);

  assert.equal(builds, 2);
});

test('a failed build is surfaced to every waiter and not cached as a value', async () => {
  const flight = new CacheSingleFlight<string>();
  const gate = deferred<string>();

  const first = flight.run('key-1', async () => gate.promise);
  const second = flight.run('key-1', async () => gate.promise);

  gate.reject(new Error('BUILD_FAILED'));
  const [a, b] = await Promise.all([first, second]);

  assert.equal(a.status, 'failed');
  assert.equal(b.status, 'failed');
  // The next caller must be allowed to try again: a transient failure is not a
  // permanent negative cache entry.
  const retry = await flight.run('key-1', async () => 'recovered');
  assert.equal(retry.status, 'built');
  assert.equal(retry.value, 'recovered');
});

test('repeated failures are bounded so a broken origin cannot be hammered', async () => {
  const flight = new CacheSingleFlight<string>({ maxConsecutiveFailures: 2 });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await flight.run('key-1', async () => {
      throw new Error('ORIGIN_DOWN');
    });
    assert.equal(result.status, 'failed');
  }

  let builds = 0;
  const blocked = await flight.run('key-1', async () => {
    builds += 1;
    return 'should not run';
  });

  assert.equal(blocked.status, 'circuit_open');
  assert.equal(builds, 0, 'a broken origin must stop being called, not be retried forever');
});

test('a successful build clears the failure budget', async () => {
  const flight = new CacheSingleFlight<string>({ maxConsecutiveFailures: 2 });

  await flight.run('key-1', async () => {
    throw new Error('ORIGIN_DOWN');
  });
  const ok = await flight.run('key-1', async () => 'recovered');
  assert.equal(ok.status, 'built');

  // One earlier failure must not count against the next independent failure run.
  const failedAgain = await flight.run('key-1', async () => {
    throw new Error('ORIGIN_DOWN');
  });
  assert.equal(failedAgain.status, 'failed', 'the budget restarted after the success');
});

test('the circuit is per key', async () => {
  const flight = new CacheSingleFlight<string>({ maxConsecutiveFailures: 1 });

  await flight.run('key-1', async () => {
    throw new Error('ORIGIN_DOWN');
  });

  const other = await flight.run('key-2', async () => 'fine');
  assert.equal(other.status, 'built', 'one broken key must not block unrelated keys');
});

test('in-flight state is released so a later build can start', async () => {
  const flight = new CacheSingleFlight<string>();
  await flight.run('key-1', async () => 'first');

  assert.equal(flight.inFlightCount(), 0, 'a finished build must not leak an in-flight slot');

  const second = await flight.run('key-1', async () => 'second');
  assert.equal(second.status === 'built' ? second.value : undefined, 'second');
});
