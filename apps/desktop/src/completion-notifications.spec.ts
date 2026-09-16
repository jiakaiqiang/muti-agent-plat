import assert from 'node:assert/strict';
import test from 'node:test';
import { CompletionNotifications, notificationText, type CompletionNotice } from './completion-notifications';

const time = (second: number) => `2026-09-14T10:00:${String(second).padStart(2, '0')}.000Z`;
const event = (id: string, second: number, status = 'COMPLETED') => ({ id, type: 'session_status_changed', createdAt: time(second), metadata: { payload: { status } } });
function fixture() {
  const input = { sessions: [{ id: 's1', title: '实现通知', updatedAt: time(0) }], events: [] as ReturnType<typeof event>[], enabled: true, fail: false };
  const notices: CompletionNotice[] = [];
  const errors: unknown[] = [];
  const monitor = new CompletionNotifications({
    sessions: async () => input.sessions,
    events: async () => { if (input.fail) throw new Error('offline'); return input.events; },
    enabled: () => input.enabled,
    notify: item => { notices.push(item); }, onError: error => { errors.push(error); }
  });
  return { input, notices, errors, monitor };
}

test('initial history is silent; completed events notify once and edits do not notify again', async () => {
  const { input, monitor, notices } = fixture();
  input.events = [event('history', 0)];
  await monitor.poll();
  assert.equal(notices.length, 0);
  input.sessions[0].updatedAt = time(2);
  input.events.push(event('completed', 1), event('completed', 1));
  await monitor.poll(); await monitor.poll();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].sessionId, 's1');
  input.sessions[0].updatedAt = time(3);
  await monitor.poll();
  assert.equal(notices.length, 1);
});

test('failed, cancelled and individual agent completion never masquerade as session completion', async () => {
  const { input, monitor, notices } = fixture();
  await monitor.poll();
  input.sessions[0].updatedAt = time(4);
  input.events = [event('failed', 1, 'FAILED'), event('cancelled', 2, 'CANCELLED'), { ...event('agent', 3), type: 'task_completed' }];
  await monitor.poll();
  assert.equal(notices.length, 0);
});

test('a new completion round and a new session both notify without relying on selected UI session', async () => {
  const { input, monitor, notices } = fixture();
  await monitor.poll();
  input.sessions[0].updatedAt = time(2);
  input.events = [event('first', 1)]; await monitor.poll();
  input.sessions[0].updatedAt = time(5);
  input.events = [event('first', 1), event('resumed', 3, 'EXECUTING'), event('second', 4)]; await monitor.poll();
  assert.deepEqual(notices.map(item => item.eventId), ['first', 'second']);
  input.sessions.push({ id: 's2', title: '其他会话', updatedAt: time(6) });
  input.events = [event('new-session', 6)]; await monitor.poll();
  assert.equal(notices.at(-1)?.sessionId, 's2');
});

test('network failure retries without losing completion; disabled interval is consumed silently', async () => {
  const { input, monitor, notices, errors } = fixture();
  await monitor.poll();
  input.sessions[0].updatedAt = time(2); input.events = [event('done', 1)]; input.fail = true;
  await monitor.poll(); assert.equal(errors.length, 1);
  input.fail = false; await monitor.poll(); assert.equal(notices.length, 1);
  input.enabled = false; input.sessions[0].updatedAt = time(4); input.events.push(event('muted', 3));
  await monitor.poll(); input.enabled = true; await monitor.poll();
  assert.equal(notices.length, 1);
});

test('stop/platform switch discards in-flight results and concurrent polling is coalesced', async () => {
  let resolveEvents!: (items: ReturnType<typeof event>[]) => void;
  let updatedAt = time(0);
  let reads = 0;
  let count = 0;
  const monitor = new CompletionNotifications({
    sessions: async () => { reads++; return [{ id: 's1', title: '旧平台', updatedAt }]; },
    events: () => new Promise(resolve => { resolveEvents = resolve; }),
    enabled: () => true, notify: () => { count++; }, onError: assert.fail
  });
  await monitor.poll(); updatedAt = time(2);
  const pending = monitor.poll(); await Promise.resolve(); await monitor.poll();
  assert.equal(reads, 2);
  monitor.stop(); resolveEvents([event('done', 1)]); await pending;
  assert.equal(count, 0);
});

test('toast content is concise and only contains a sanitized session title', () => {
  assert.deepEqual(notificationText('需求\n开发'), { title: '任务已完成', body: '需求 开发\n点击查看执行结果' });
  assert.ok(notificationText('a'.repeat(1000)).body.length < 130);
});
