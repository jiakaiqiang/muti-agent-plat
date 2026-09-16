import { isDeepStrictEqual } from 'node:util';

/** Apply only the caller's changes to a newer snapshot. Collections with stable
 * record IDs merge by record and field; ordered primitive arrays are values. */
export function applyStateDelta(base: unknown, changed: unknown, current: unknown): unknown {
  if (isDeepStrictEqual(base, changed)) return structuredClone(current);
  if (base === undefined && Array.isArray(changed)) base = [];
  if (base === undefined && isRecord(changed)) base = {};
  if (isRecord(base) && isRecord(changed)) {
    const result: Record<string, unknown> = isRecord(current) ? structuredClone(current) : {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(changed)])) {
      if (!Object.hasOwn(changed, key)) delete result[key];
      else if (!isDeepStrictEqual(base[key], changed[key])) result[key] = applyStateDelta(base[key], changed[key], result[key]);
    }
    return result;
  }
  if (Array.isArray(base) && Array.isArray(changed) && Array.isArray(current)) {
    const key = ['id', 'invocationId', 'idempotencyKey'].find(key =>
      [base, changed, current].every(items => items.every(item => isRecord(item) && typeof item[key] === 'string') &&
        new Set(items.map(item => item[key])).size === items.length));
    if (key) {
      const before = new Map(base.map(item => [item[key], item]));
      const after = new Map(changed.map(item => [item[key], item]));
      const result = current.filter(item => !before.has(item[key]) || after.has(item[key])).map(item =>
        after.has(item[key]) && before.has(item[key])
          ? applyStateDelta(before.get(item[key]), after.get(item[key]), item) : structuredClone(item));
      const present = new Set(current.map(item => item[key]));
      for (const item of changed) if (!present.has(item[key]) && !before.has(item[key])) result.push(structuredClone(item));
      return result;
    }
  }
  return structuredClone(changed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
