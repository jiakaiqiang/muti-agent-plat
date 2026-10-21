import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { IsolatedTestRunnerService } from './isolated-test-runner.service.js';
import { TestRunnerTool, type TestRunnerOutput } from '../tools/builtin/test-runner.tool.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'isolated-test-fixture-'));
  t.after(async () => { const child = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(child.startsWith('isolated-test-fixture-') && !child.includes('..') && !isAbsolute(child)); await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node --test proof.test.cjs' } }));
  await writeFile(join(directory, 'proof.test.cjs'), '');
  const previous = process.env.INTENT_ISOLATED_TEST_IMAGE;
  process.env.INTENT_ISOLATED_TEST_IMAGE = `sha256:${'a'.repeat(64)}`;
  t.after(() => { if (previous === undefined) delete process.env.INTENT_ISOLATED_TEST_IMAGE; else process.env.INTENT_ISOLATED_TEST_IMAGE = previous; });
  return directory;
}

test('isolation rejects unpinned images, arbitrary scripts and pre-aborted execution without invoking Docker', async t => {
  const root = await fixture(t), runner = new IsolatedTestRunnerService(); let calls = 0;
  (runner as any).command = async () => { calls++; throw new Error('unexpected docker'); };
  process.env.INTENT_ISOLATED_TEST_IMAGE = 'node:latest';
  await assert.rejects(runner.run({ workingDirectory: root, script: 'test', timeoutMs: 1000 }), /IMAGE_REQUIRED/);
  process.env.INTENT_ISOLATED_TEST_IMAGE = `sha256:${'a'.repeat(64)}`;
  await assert.rejects(runner.run({ workingDirectory: root, script: 'deploy', timeoutMs: 1000 }), /SCRIPT_NOT_ALLOWED/);
  const controller = new AbortController(); controller.abort();
  const result = await runner.run({ workingDirectory: root, script: 'test', timeoutMs: 1000, signal: controller.signal });
  assert.equal(calls, 0); assert.equal(result.aborted, true); assert.equal(result.isolation.stopConfirmed, true);
});

test('snapshot filters secrets, binds a hash and uses fixed isolated Docker arguments', async t => {
  const root = await fixture(t), runner = new IsolatedTestRunnerService();
  await writeFile(join(root, '.env'), 'TOP_SECRET=hidden');
  await mkdir(join(root, 'node_modules')); await writeFile(join(root, 'node_modules', 'ignored'), 'dependency');
  const commands: string[][] = []; let snapshotPath = '', guards = 0;
  (runner as any).command = async (args: string[]) => {
    commands.push(args);
    if (args[0] === 'create') {
      snapshotPath = args[args.indexOf('--mount') + 1].match(/src=(.*),dst=/)![1];
      assert.deepEqual((await readdir(snapshotPath)).sort(), ['package.json', 'proof.test.cjs']);
    }
    return { code: args[0] === 'inspect' && !args.includes('{{json .State}}') ? 1 : 0,
      stdout: args[0] === 'image' ? 'linux|null' : args.includes('{{json .State}}') ? '{"Running":false,"ExitCode":0}' : 'ok',
      stderr: 'Error: No such object: container', timedOut: false, aborted: false, truncated: false };
  };
  const result = await runner.run({ workingDirectory: root, script: 'test', timeoutMs: 10000, beforeLaunch: async () => { guards++; } });
  assert.equal(result.exitCode, 0); assert.equal(result.isolation.stopConfirmed, true); assert.match(result.isolation.snapshotHash!, /^[a-f0-9]{64}$/);
  const create = commands.find(args => args[0] === 'create')!;
  for (const [flag, expected] of [['--network', 'none'], ['--cap-drop', 'ALL'], ['--user', '65534:65534'], ['--pull', 'never']]) assert.equal(create[create.indexOf(flag) + 1], expected);
  assert.ok(create.includes('--read-only')); assert.ok(create.includes('-i')); assert.equal(guards, 2);
  await assert.rejects(readFile(join(snapshotPath, 'package.json')));
});

test('symlink snapshots and a changed execution guard never launch a test process', async t => {
  const root = await fixture(t);
  for (const mode of ['symlink', 'guard']) {
    const runner = new IsolatedTestRunnerService(); let launches = 0;
    (runner as any).command = async (args: string[]) => { if (args[0] === 'start') launches++; return { code: 0, stdout: 'linux|null', stderr: '', timedOut: false, aborted: false, truncated: false }; };
    if (mode === 'symlink') { await mkdir(join(root, 'outside')); await symlink(join(root, 'outside'), join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
    const result = await runner.run({ workingDirectory: root, script: 'test', timeoutMs: 10000, beforeLaunch: async () => { throw new Error('stale execution'); } });
    assert.equal(launches, 0); assert.ok(result.error); assert.equal(result.isolation.stopConfirmed, true);
    if (mode === 'symlink') await rm(join(root, 'link'), { force: true, recursive: false });
  }
});

test('a workspace root reached through a symlink or junction is never used as authorized source', async t => {
  const root = await fixture(t); await mkdir(join(root, 'original'));
  await symlink(join(root, 'original'), join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  const runner = new IsolatedTestRunnerService(); let launches = 0;
  (runner as any).command = async (args: string[]) => { if (args[0] === 'create' || args[0] === 'start') launches++;
    return { code: 0, stdout: args[0] === 'image' ? 'linux|null' : 'daemon', stderr: '', timedOut: false, aborted: false, truncated: false }; };
  const result = await runner.run({ workingDirectory: join(root, 'redirect'), script: 'test', timeoutMs: 10000 });
  assert.equal(result.error, 'ISOLATED_TEST_SYMLINK_UNSUPPORTED'); assert.equal(launches, 0); assert.equal(result.isolation.stopConfirmed, true);
  await rm(join(root, 'redirect'), { force: true, recursive: false });
});

test('real Docker isolates source, network and credentials and terminates test descendants', { skip: !process.env.INTENT_TEST_DOCKER_IMAGE }, async t => {
  const root = await fixture(t); process.env.INTENT_ISOLATED_TEST_IMAGE = process.env.INTENT_TEST_DOCKER_IMAGE;
  await writeFile(join(root, 'source.txt'), 'original-source'); await writeFile(join(root, '.env'), 'FIXTURE_CREDENTIAL=secret');
  await writeFile(join(root, 'proof.test.cjs'), `const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),net=require('node:net');
test('no source writes, secret or host environment',()=>{assert.throws(()=>fs.writeFileSync('/input/source.txt','changed'));assert.throws(()=>fs.readFileSync('/input/.env'));assert.equal(process.env.ISOLATION_HOST_SECRET,undefined);assert.equal(process.getuid(),65534);assert.throws(()=>fs.writeFileSync('/outside.txt','changed'));fs.writeFileSync('scratch-only.txt','allowed');});
test('no outbound network',async()=>{await new Promise((resolve,reject)=>{const s=net.connect({host:'198.51.100.1',port:443});s.setTimeout(1000,()=>s.destroy(new Error('timeout')));s.on('connect',()=>{s.destroy();reject(new Error('network unexpectedly available'))});s.on('error',resolve)});});`);
  process.env.ISOLATION_HOST_SECRET = 'never-forward'; t.after(() => { delete process.env.ISOLATION_HOST_SECRET; });
  const runner = new IsolatedTestRunnerService();
  const result = await runner.run({ workingDirectory: root, script: 'test', timeoutMs: 20_000 });
  assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.isolation.stopConfirmed, true); assert.equal(result.error, undefined);
  assert.match(result.stdout, /# pass 2/); assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'original-source');
  await assert.rejects(readFile(join(root, 'scratch-only.txt')));
  const tool = new TestRunnerTool({ checkInvocation: () => ({ allowed: true }) } as never, undefined, runner);
  const throughTool = await tool.execute({ script: 'test', timeout: 20000 }, { workingDirectory: root, sessionId: 'fixture', requireTestIsolation: true });
  assert.equal(throughTool.success, true, JSON.stringify(throughTool));
  assert.equal((throughTool.output as TestRunnerOutput).summary.passed, 2);
  assert.equal((throughTool.output as TestRunnerOutput).isolation?.stopConfirmed, true);
  await writeFile(join(root, 'proof.test.cjs'), `require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});setInterval(()=>{},1000);`);
  const timed = await runner.run({ workingDirectory: root, script: 'test', timeoutMs: 3000 });
  assert.equal(timed.timedOut, true); assert.equal(timed.isolation.stopConfirmed, true); assert.equal(timed.isolation.cleanupRequired, false);
});

test('failed container removal preserves unknown stop and snapshot for reconciliation', async t => {
  const root = await fixture(t), runner = new IsolatedTestRunnerService(); let snapshotPath = '';
  (runner as any).command = async (args: string[]) => {
    if (args[0] === 'create') snapshotPath = args[args.indexOf('--mount') + 1].match(/src=(.*),dst=/)![1];
    return { code: args[0] === 'rm' ? 1 : 0, stdout: args[0] === 'image' ? 'linux|null' : args.includes('{{json .State}}')
      ? '{"Running":false,"ExitCode":0}' : 'container-still-exists', stderr: 'daemon busy', timedOut: false, aborted: false, truncated: false };
  };
  const result = await runner.run({ workingDirectory: root, script: 'test', timeoutMs: 10000 });
  assert.equal(result.error, 'ISOLATED_TEST_STOP_UNCONFIRMED'); assert.equal(result.exitCode, null);
  assert.equal(result.isolation.stopConfirmed, false); assert.equal(result.isolation.cleanupRequired, true);
  assert.ok(await readFile(join(snapshotPath, 'package.json')));
  // The Docker command is mocked; no process owns this exact fixture snapshot.
  const parent = resolve(snapshotPath, '..'), child = relative(resolve(tmpdir()), parent);
  assert.ok(child.startsWith('intent-test-snapshot-') && !child.includes('..') && !isAbsolute(child));
  await rm(parent, { recursive: true, force: true });
});
