import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileWriterTool } from './file-writer.tool.js';
import type { CapabilitiesService } from '../../capabilities/capabilities.service.js';
import type { CapabilityAuditService } from '../../capabilities/capability-audit.service.js';

type CapabilityCheckResult = ReturnType<CapabilitiesService['checkInvocation']>;

function allowedCheck(): CapabilityCheckResult {
  return {
    allowed: true,
    capability: {
      id: 'cap-file-write',
      key: 'file.write',
      name: 'File write',
      description: 'Write workspace files',
      riskLevel: 'high'
    },
    approvalKey: 'session-1:any:cap-file-write',
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

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), 'file-writer-tool-'));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test('exposes stable file writer metadata', () => {
  const { capabilities } = makeCapabilities(allowedCheck());
  const tool = new FileWriterTool(capabilities);

  assert.equal(tool.name, 'write_file');
  assert.equal(tool.category, 'file');
  assert.equal(tool.riskLevel, 'high');
  assert.equal(tool.inputSchema.type, 'object');
  assert.deepEqual(tool.inputSchema.required, ['path', 'operation']);
});

test('checks cap-file-write before writing', async () => {
  await withWorkspace(async (workspace) => {
    const { capabilities, calls } = makeCapabilities(allowedCheck());
    const tool = new FileWriterTool(capabilities);

    await tool.execute(
      { path: 'src/a.ts', content: 'export const a = 1;', operation: 'create' },
      { workingDirectory: workspace, sessionId: 'session-1', agentId: 'agent-1' }
    );

    assert.equal(calls[0]?.capabilityId, 'cap-file-write');
    assert.equal(calls[0]?.input.sessionId, 'session-1');
    assert.equal(calls[0]?.input.agentId, 'agent-1');
    assert.match(calls[0]?.input.reason ?? '', /write_file create src\/a\.ts/);
  });
});

test('rejects unauthorized writes without creating a file', async () => {
  await withWorkspace(async (workspace) => {
    const { capabilities } = makeCapabilities(blockedCheck());
    const { audit, checks, failed } = makeAudit();
    const tool = new FileWriterTool(capabilities, audit);

    const result = await tool.execute(
      { path: 'blocked.txt', content: 'nope', operation: 'create' },
      { workingDirectory: workspace, sessionId: 'session-1' }
    );

    assert.equal(result.success, false);
    assert.equal(result.error, 'CAPABILITY_REQUIRES_CONFIRMATION');
    assert.equal(checks.length, 1);
    assert.equal(failed.length, 0);
    await assert.rejects(readFile(join(workspace, 'blocked.txt'), 'utf8'));
  });
});

test('creates a new file and parent directories', async () => {
  await withWorkspace(async (workspace) => {
    const { capabilities } = makeCapabilities(allowedCheck());
    const { audit, completed } = makeAudit();
    const tool = new FileWriterTool(capabilities, audit);

    const result = await tool.execute(
      { path: 'src/generated/file.ts', content: 'export const ok = true;', operation: 'create' },
      { workingDirectory: workspace, sessionId: 'session-1' }
    );

    assert.equal(result.success, true);
    assert.deepEqual(result.output, { path: 'src/generated/file.ts', operation: 'create' });
    assert.equal(await readFile(join(workspace, 'src/generated/file.ts'), 'utf8'), 'export const ok = true;');
    assert.equal(completed.length, 1);
  });
});

test('updates a file when previousContent matches', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'target.txt'), 'old', 'utf8');
    const { capabilities } = makeCapabilities(allowedCheck());
    const tool = new FileWriterTool(capabilities);

    const result = await tool.execute(
      { path: 'target.txt', content: 'new', previousContent: 'old', operation: 'update' },
      { workingDirectory: workspace, sessionId: 'session-1' }
    );

    assert.equal(result.success, true);
    assert.equal(await readFile(join(workspace, 'target.txt'), 'utf8'), 'new');
  });
});

test('fails update when previousContent does not match current file content', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'target.txt'), 'changed elsewhere', 'utf8');
    const { capabilities } = makeCapabilities(allowedCheck());
    const { audit, failed } = makeAudit();
    const tool = new FileWriterTool(capabilities, audit);

    const result = await tool.execute(
      { path: 'target.txt', content: 'new', previousContent: 'old', operation: 'update' },
      { workingDirectory: workspace, sessionId: 'session-1' }
    );

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /changed|变|拒绝|overwrite|覆盖/i);
    assert.equal(await readFile(join(workspace, 'target.txt'), 'utf8'), 'changed elsewhere');
    assert.equal(failed.length, 1);
  });
});

test('deletes a file when previousContent matches', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'delete-me.txt'), 'remove me', 'utf8');
    const { capabilities } = makeCapabilities(allowedCheck());
    const tool = new FileWriterTool(capabilities);

    const result = await tool.execute(
      { path: 'delete-me.txt', previousContent: 'remove me', operation: 'delete' },
      { workingDirectory: workspace, sessionId: 'session-1' }
    );

    assert.equal(result.success, true);
    await assert.rejects(readFile(join(workspace, 'delete-me.txt'), 'utf8'));
  });
});

test('rejects path traversal outside the workspace', async () => {
  await withWorkspace(async (workspace) => {
    const { capabilities } = makeCapabilities(allowedCheck());
    const tool = new FileWriterTool(capabilities);

    const result = await tool.execute(
      { path: '../outside.txt', content: 'escape', operation: 'create' },
      { workingDirectory: workspace, sessionId: 'session-1' }
    );

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /workspace|工作目录|路径/);
  });
});

test('rejects invalid params before capability check', async () => {
  const { capabilities, calls } = makeCapabilities(allowedCheck());
  const tool = new FileWriterTool(capabilities);

  const result = await tool.execute({ path: 'missing-operation.txt' }, { workingDirectory: 'D:/workspace', sessionId: 's1' });

  assert.equal(result.success, false);
  assert.match(result.error ?? '', /operation/);
  assert.equal(calls.length, 0);
});
