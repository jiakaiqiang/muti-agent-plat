import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stubPath = join(__dirname, 'claude-stream-json-stub.mjs');

function readLines(child, env) {
  return new Promise((resolve, reject) => {
    const linesOut = [];
    let stdoutBuf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          linesOut.push(parsed);
          // 平台自动应答 control_request
          if (parsed.type === 'control_request') {
            const resp = JSON.stringify({
              type: 'control_response',
              request_id: parsed.request_id,
              response: { allow: true }
            }) + '\n';
            child.stdin.write(resp);
          }
        } catch {
          // ignore
        }
      }
    });
    child.on('error', reject);
    child.on('exit', () => resolve(linesOut));
    // 触发 stub
    child.stdin.write(JSON.stringify({ prompt: '你好，请读取 sample.ts' }) + '\n');
  });
}

test('claude-stream-json stub emits full event sequence with control_request roundtrip', async () => {
  const child = spawn(process.execPath, [stubPath], {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  const lines = await readLines(child);
  const types = lines.map((l) => l.type + (l.subtype ? ':' + l.subtype : ''));
  assert.ok(lines.length >= 5, `expected >=5 lines, got ${lines.length}: ${JSON.stringify(types)}`);
  assert.ok(types.some((t) => t.startsWith('system')), `missing system, got ${types}`);
  assert.ok(types.some((t) => t === 'assistant'), `missing assistant, got ${types}`);
  assert.ok(types.some((t) => t === 'control_request'), `missing control_request, got ${types}`);
  assert.ok(types.some((t) => t === 'user'), `missing user tool_result, got ${types}`);
  const result = lines.find((l) => l.type === 'result');
  assert.ok(result, `missing result`);
  assert.ok(result.session_id, 'session_id must be set');
  assert.ok(result.usage?.input_tokens > 0, 'usage.input_tokens must be > 0');
});
