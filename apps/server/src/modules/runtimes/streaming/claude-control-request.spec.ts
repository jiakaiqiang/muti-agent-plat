import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ControlRequestHandler,
  encodeControlResponse,
  type ControlRequest
} from './claude-control-request.js';

test('ControlRequestHandler: can_use_tool 默认 allow=true', () => {
  const h = new ControlRequestHandler();
  const req: ControlRequest = {
    type: 'control_request',
    request_id: 'r1',
    request: { subtype: 'can_use_tool', tool_name: 'read_file' }
  };
  const res = h.handle(req);
  assert.deepEqual(res, { allow: true });
});

test('encodeControlResponse: 编成 stream-json 单行 + 换行', () => {
  const line = encodeControlResponse('r1', { allow: true });
  assert.equal(line.endsWith('\n'), true);
  const parsed = JSON.parse(line.trim());
  assert.equal(parsed.type, 'control_response');
  assert.equal(parsed.request_id, 'r1');
  assert.deepEqual(parsed.response, { allow: true });
});

test('ControlRequestHandler: 未知 subtype → allow=false 并记录 warning', () => {
  const warnings: string[] = [];
  const h = new ControlRequestHandler({ warn: (m) => warnings.push(m) });
  const req: ControlRequest = {
    type: 'control_request',
    request_id: 'r2',
    request: { subtype: 'unknown_subtype_xyz' as never }
  };
  const res = h.handle(req);
  assert.deepEqual(res, { allow: false, reason: 'unsupported subtype: unknown_subtype_xyz' });
  assert.ok(warnings.some((w) => w.includes('unknown_subtype_xyz')));
});
