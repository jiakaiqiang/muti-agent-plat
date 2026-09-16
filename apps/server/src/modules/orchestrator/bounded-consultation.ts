/** Only independent, read-only consultations belong here; workflow nodes keep their own dependency order. */
export async function boundedConsultations<T, R>(items: readonly T[], concurrency: number,
  execute: (item: T) => Promise<R>, shouldStop: (result: R) => boolean, signal?: AbortSignal): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length);
  let next = 0;
  let stopped = false;
  let failure: unknown;
  let hasFailure = false;
  const limit = Math.min(items.length, Math.max(1, Math.min(4, Number.isFinite(concurrency) ? Math.floor(concurrency) : 1)));
  await Promise.all(Array.from({ length: limit }, async () => {
    while (!stopped && !signal?.aborted) {
      const index = next++;
      if (index >= items.length) return;
      try {
        const result = await execute(items[index]);
        results[index] = result;
        if (shouldStop(result)) stopped = true;
      } catch (error) {
        stopped = true;
        if (!hasFailure) failure = error;
        hasFailure = true;
      }
    }
  }));
  if (hasFailure) throw failure;
  return results;
}

export function consultationConcurrency() {
  const value = Number(process.env.DISCUSSION_CONCURRENCY ?? 1);
  return Number.isFinite(value) ? Math.max(1, Math.min(4, Math.floor(value))) : 1;
}
