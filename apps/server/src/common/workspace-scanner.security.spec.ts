import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanServerWorkspace } from './workspace-scanner.js';

test('server_local rejects the platform repository and every directory below it', async () => {
  const platformRoot = await mkdtemp(join(tmpdir(), 'agent-cluster-platform-root-'));
  const businessRoot = await mkdtemp(join(tmpdir(), 'agent-cluster-business-root-'));
  const previous = process.env.AGENT_CLUSTER_PLATFORM_ROOT;
  try {
    const sourceDirectory = join(platformRoot, 'apps', 'server', 'src');
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, 'main.ts'), 'export {};\n', 'utf8');
    await writeFile(join(businessRoot, 'package.json'), '{"name":"business"}\n', 'utf8');
    process.env.AGENT_CLUSTER_PLATFORM_ROOT = platformRoot;

    await assert.rejects(scanServerWorkspace(platformRoot), /平台仓库/);
    await assert.rejects(scanServerWorkspace(sourceDirectory), /平台仓库/);
    const allowed = await scanServerWorkspace(businessRoot);
    assert.equal(allowed.workingDirectory.kind, 'server_local');
    assert.equal(allowed.workingDirectory.path, businessRoot);
  } finally {
    if (previous === undefined) delete process.env.AGENT_CLUSTER_PLATFORM_ROOT;
    else process.env.AGENT_CLUSTER_PLATFORM_ROOT = previous;
    await rm(platformRoot, { recursive: true, force: true });
    await rm(businessRoot, { recursive: true, force: true });
  }
});
