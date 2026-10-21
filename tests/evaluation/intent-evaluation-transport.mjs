import {setTimeout as delay} from 'node:timers/promises';

export async function runSerial(items, run) {
  for (const [index, item] of items.entries()) await run(item, index);
}

// Evaluation admission retries only. Never retry a request that reached the provider,
// including timeouts, invalid JSON, or a semantically wrong answer.
export async function withCircuitCooldown(runAttempt, {
  sleep = delay, now = Date.now, persist = async () => {},
  progress = () => {}, maxCooldownRetries = 3
} = {}) {
  const attempts = [];
  let waitTotalMs = 0;
  for (;;) {
    const row = await runAttempt();
    const entry = {attempt: attempts.length + 1, result: row, requestedWaitMs: 0, actualWaitMs: 0};
    attempts.push(entry);
    const circuitOnly = row.providerCalls === 0 && !row.modelOutputSeen &&
      !row.actual?.understanding &&
      row.actual?.reasonCodes?.includes('INTENT_PROVIDER_CIRCUIT_OPEN');
    const delays = (row.invocations ?? []).flatMap(invocation => {
      const details = invocation.error?.details;
      return details?.circuitOpen && Number.isFinite(details.retryAfterMs) && details.retryAfterMs > 0
        ? [details.retryAfterMs] : [];
    });
    let stopReason = 'result_retained';
    if (circuitOnly && !delays.length) stopReason = 'circuit_retry_after_missing';
    else if (circuitOnly && attempts.length > maxCooldownRetries) stopReason = 'circuit_retry_limit';
    else if (circuitOnly) {
      entry.requestedWaitMs = Math.ceil(Math.max(...delays));
      await persist({attempts, waitTotalMs, state: 'waiting'});
      const started = now();
      // Bound individual sleeps and expose progress for long cooldowns.
      let remaining = entry.requestedWaitMs;
      while (remaining > 0) {
        progress({attempt: entry.attempt, event: 'circuit_cooldown_wait', remainingMs: remaining});
        await sleep(Math.min(remaining, 60_000));
        remaining = Math.max(0, entry.requestedWaitMs - (now() - started));
      }
      entry.actualWaitMs = now() - started;
      waitTotalMs += entry.actualWaitMs;
      await persist({attempts, waitTotalMs, state: 'retrying'});
      continue;
    }
    const transport = {attempts, retryCount: attempts.length - 1, waitTotalMs, stopReason};
    await persist({...transport, state: 'finished'});
    return {...row, transport};
  }
}
