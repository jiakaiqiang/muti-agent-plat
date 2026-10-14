/** Provider debug payloads are untrusted and may contain hidden reasoning or credentials. */
export function sanitizeRuntimeDiagnostic(value: unknown, depth = 0, preserveText = false): unknown {
  if (!preserveText && depth > 12) return '[truncated]';
  if (Array.isArray(value)) return (preserveText ? value : value.slice(0, 256)).map(v => sanitizeRuntimeDiagnostic(v, depth + 1, preserveText));
  if (!value || typeof value !== 'object') return typeof value === 'string' && !preserveText ? value.slice(0, 8192) : value;
  const record = value as Record<string, unknown>;
  if (/thinking|reasoning/i.test(String(record.type ?? record.method ?? ''))) {
    return { type: record.type, method: record.method, id: record.id, redacted: true };
  }
  const entries = Object.entries(record);
  return Object.fromEntries((preserveText ? entries : entries.slice(0, 256)).filter(([key]) =>
    !/^(thinking|reasoning)(_|$)|^(signature|encrypted_content|prompt|system_prompt|api[_-]?key|authorization|auth[_-]?token|access[_-]?token)$/i.test(key)
  ).map(([key, v]) => [key, sanitizeRuntimeDiagnostic(v, depth + 1, preserveText)]));
}
export function sanitizeRuntimeLine(line: string) {
  try { return JSON.stringify(sanitizeRuntimeDiagnostic(JSON.parse(line), 0, true)); }
  catch { return line.slice(-8192).replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[redacted]'); }
}

/** Handles split JSON diagnostic lines before capturing; oversized diagnostics are dropped. */
export class RuntimeDiagnosticCapture {
  private pending = '';
  private dropping = false;
  constructor(private readonly emit: (line: string) => void) {}
  feed(chunk: string) {
    const lines = chunk.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (!this.dropping) this.pending += lines[index];
      if (this.pending.length > 65536) { this.pending = ''; this.dropping = true; }
      if (index < lines.length - 1) this.flush();
    }
  }
  flush() {
    if (this.dropping) this.emit('[oversized diagnostic omitted]\n');
    else if (this.pending) this.emit(sanitizeRuntimeLine(this.pending) + '\n');
    this.pending = ''; this.dropping = false;
  }
}
