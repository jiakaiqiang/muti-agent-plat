import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TestRunnerTool, type TestRunnerOutput } from './test-runner.tool.js';
import type { CapabilitiesService } from '../../capabilities/capabilities.service.js';
import type { CapabilityAuditService } from '../../capabilities/capability-audit.service.js';

type CapabilityCheckResult = ReturnType<CapabilitiesService['checkInvocation']>;

function allowedCheck(): CapabilityCheckResult {
  return {
    allowed: true,
    capability: {
      id: 'cap-command-run',
      key: 'tool.command_run',
      name: 'Command run',
      riskLevel: 'high',
      description: 'Run controlled commands'
    },
    approvalKey: 'session-1:any:cap-command-run',
    requiresUserConfirmation: false
  };
}

function blockedCheck(): CapabilityCheckResult {
  return {
    ...allowedCheck(),
    allowed: false,
    code: 'CAPABILITY_REQUIRES_CONFIRMATION',
    requiresUserConfirmation: true
  };
}

function makeCapabilities(result: CapabilityCheckResult) {
  const calls: Array<{ capabilityId: string; input: { sessionId?: string; agentId?: string; reason?: string } }> = [];
  const capabilities = {
    checkInvocation(capabilityId: string, input: { sessionId?: string; agentId?: string; reason?: string }) {
      calls.push({ capabilityId, input });
      return result;
    }
  } as CapabilitiesService;

  return { capabilities, calls };
}

function makeAudit() {
  const checks: Array<unknown> = [];
  const completed: Array<unknown> = [];
  const failed: Array<unknown> = [];
  const audit = {
    recordCheck(input: unknown, result: unknown) {
      checks.push({ input, result });
    },
    recordToolCompleted(input: unknown, output: unknown) {
      completed.push({ input, output });
    },
    recordToolFailed(input: unknown, error: unknown) {
      failed.push({ input, error });
    }
  } as CapabilityAuditService;

  return { audit, checks, completed, failed };
}

async function withPackage(scripts: Record<string, string>, run: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), 'test-runner-tool-'));
  try {
    await writeFile(join(workspace, 'package.json'), JSON.stringify({ private: true, scripts }, null, 2), 'utf8');
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function output(result: { output: unknown }): TestRunnerOutput {
  return result.output as TestRunnerOutput;
}

test('exposes stable test runner metadata', () => {
  const { capabilities } = makeCapabilities(allowedCheck());
  const tool = new TestRunnerTool(capabilities);

  assert.equal(tool.name, 'run_test');
  assert.equal(tool.category, 'test');
  assert.equal(tool.riskLevel, 'high');
  assert.equal(tool.inputSchema.type, 'object');
  assert.equal((tool.inputSchema.properties.script as { type: string }).type, 'string');
});

test('blocks command execution before approval', async () => {
  await withPackage({ test: 'node -e "require(\'fs\').writeFileSync(\'marker.txt\',\'ran\')"' }, async (workspace) => {
    const { capabilities, calls } = makeCapabilities(blockedCheck());
    const { audit, checks } = makeAudit();
    const tool = new TestRunnerTool(capabilities, audit);

    const result = await tool.execute({ script: 'test' }, { workingDirectory: workspace, sessionId: 'session-1' });

    assert.equal(result.success, false);
    assert.equal(result.error, 'CAPABILITY_REQUIRES_CONFIRMATION');
    assert.equal(calls[0]?.capabilityId, 'cap-command-run');
    assert.equal(checks.length, 1);
    await assert.rejects(access(join(workspace, 'marker.txt')));
  });
});

test('rejects invalid script names before capability check', async () => {
  const { capabilities, calls } = makeCapabilities(allowedCheck());
  const tool = new TestRunnerTool(capabilities);

  const result = await tool.execute({ script: 'test && rm -rf .' }, { workingDirectory: 'D:/workspace', sessionId: 's1' });

  assert.equal(result.success, false);
  assert.match(result.error ?? '', /Invalid npm script/);
  assert.equal(calls.length, 0);
});

test('rejects package scripts that do not exist', async () => {
  await withPackage({ test: 'node -e "console.log(\'ok\')"' }, async (workspace) => {
    const { capabilities } = makeCapabilities(allowedCheck());
    const tool = new TestRunnerTool(capabilities);

    const result = await tool.execute({ script: 'missing' }, { workingDirectory: workspace, sessionId: 's1' });

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /Npm script not found/);
  });
});

test('runs an allowed passing npm script and parses summary output', async () => {
  await withPackage({ test: 'node -e "console.log(\'2 tests passed\')"' }, async (workspace) => {
    const { capabilities } = makeCapabilities(allowedCheck());
    const { audit, completed } = makeAudit();
    const tool = new TestRunnerTool(capabilities, audit);

    const result = await tool.execute({ script: 'test' }, { workingDirectory: workspace, sessionId: 's1' });

    assert.equal(result.success, true);
    assert.equal(output(result).script, 'test');
    assert.equal(output(result).exitCode, 0);
    assert.equal(output(result).summary.total, 2);
    assert.equal(output(result).summary.passed, 2);
    assert.match(output(result).stdout, /2 tests passed/);
    assert.equal(completed.length, 1);
  });
});

test('returns structured output for failing npm scripts', async () => {
  await withPackage({ test: 'node -e "console.error(\'1 test failed\'); process.exit(1)"' }, async (workspace) => {
    const { capabilities } = makeCapabilities(allowedCheck());
    const { audit, failed } = makeAudit();
    const tool = new TestRunnerTool(capabilities, audit);

    const result = await tool.execute({ script: 'test' }, { workingDirectory: workspace, sessionId: 's1' });

    assert.equal(result.success, false);
    assert.equal(output(result).exitCode, 1);
    assert.equal(output(result).summary.failed, 1);
    assert.match(output(result).stderr, /1 test failed/);
    assert.equal(failed.length, 1);
  });
});

test('enforces timeout and returns structured timeout output', async () => {
  await withPackage({ test: 'node -e "setTimeout(() => {}, 1000)"' }, async (workspace) => {
    const { capabilities } = makeCapabilities(allowedCheck());
    const tool = new TestRunnerTool(capabilities);

    const result = await tool.execute({ script: 'test', timeout: 50 }, { workingDirectory: workspace, sessionId: 's1' });

    assert.equal(result.success, false);
    assert.equal(output(result).timedOut, true);
    assert.match(result.error ?? '', /timed out/i);
  });
});

test('supports AbortSignal cancellation', async () => {
  await withPackage({ test: 'node -e "setTimeout(() => {}, 1000)"' }, async (workspace) => {
    const { capabilities } = makeCapabilities(allowedCheck());
    const tool = new TestRunnerTool(capabilities);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const result = await tool.execute(
      { script: 'test', timeout: 1000 },
      { workingDirectory: workspace, sessionId: 's1', signal: controller.signal }
    );

    assert.equal(result.success, false);
    assert.equal(output(result).aborted, true);
  });
});

test('defaults to the test script', async () => {
  await withPackage({ test: 'node -e "require(\'fs\').writeFileSync(\'default.txt\',\'ok\')"' }, async (workspace) => {
    const { capabilities } = makeCapabilities(allowedCheck());
    const tool = new TestRunnerTool(capabilities);

    const result = await tool.execute({}, { workingDirectory: workspace, sessionId: 's1' });

    assert.equal(result.success, true);
    assert.equal(output(result).script, 'test');
    assert.equal(await readFile(join(workspace, 'default.txt'), 'utf8'), 'ok');
  });
});
