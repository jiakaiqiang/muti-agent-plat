#!/usr/bin/env node
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { unlink, writeFile } from 'node:fs/promises';
import { DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY, LOCAL_RUNTIME_PERMISSION_KEYS } from '@agent-cluster/shared';
import type { LocalRuntimePermission } from '@agent-cluster/shared';
import {
  installLocalRuntimeProtocolHandler,
  normalizeLocalRuntimeServerUrl,
  parseLocalRuntimeLaunchUrl,
  updateTrustedLocalRuntimeServer
} from './protocol-handler.js';
import { createDeviceCode, approveDeviceCode, exchangeDeviceCode, fetchDeviceStatus, revokeDevice, runBridge } from './transport.js';
import { createWorkspaceState, LocalWorkspace } from './workspace.js';
import { loadState, removeWorkspace, saveState, stateFilePath } from './state.js';

const CLI_VERSION = '0.1.0';

void main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main(args: string[]) {
  const command = args[0] ?? 'help';
  const state = await loadState();
  const server = option(args, '--server');
  if (server) {
    updateTrustedLocalRuntimeServer(state, server);
    await saveState(state);
  }

  if (command === 'version' || args.includes('--version')) {
    process.stdout.write(`agent-runtime ${CLI_VERSION}\n`);
    return;
  }
  if (command === 'login') {
    await saveState(state);
    const code = await createDeviceCode(state, CLI_VERSION);
    process.stdout.write(`Open ${code.verificationUri} and approve code ${code.userCode}.\n`);
    if (!code.compatibility.compatible) throw new Error(code.compatibility.reason ?? 'CLI version is incompatible.');
    if (args.includes('--approve')) {
      const adminToken = option(args, '--admin-token') ?? process.env.LOCAL_RUNTIME_ADMIN_TOKEN?.trim();
      if (!adminToken) {
        throw new Error('login --approve requires --admin-token or LOCAL_RUNTIME_ADMIN_TOKEN.');
      }
      process.stdout.write('Using explicit single-user CLI approval.\n');
      await approveDeviceCode(state, code.userCode, adminToken);
    }
    while (Date.parse(code.expiresAt) > Date.now()) {
      const result = await exchangeDeviceCode(state, code.deviceCode);
      if ('accessToken' in result) {
        state.tokens = result;
        await saveState(state);
        process.stdout.write(`Device ${state.deviceId} is authenticated.\n`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, result.retryAfterSeconds * 1000));
    }
    throw new Error('Device authorization expired. Run login again.');
  }
  if (command === 'start') {
    await startRuntime(state);
    return;
  }
  if (command === 'launch-uri') {
    const launchUrl = args[1];
    if (!launchUrl) throw new Error('Usage: agent-runtime launch-uri <agent-runtime://connect?...>');
    const launch = parseLocalRuntimeLaunchUrl(launchUrl, state.serverUrl);
    if ('kind' in launch && launch.kind === 'upgrade') {
      await upgradeRuntime(state, launch.upgradeId);
      return;
    }
    await startRuntime(state);
    return;
  }
  if (command === 'upgrade') {
    const upgradeId = args[1];
    if (!upgradeId) throw new Error('Usage: agent-runtime upgrade <upgrade-id>');
    await upgradeRuntime(state, upgradeId);
    return;
  }
  if (command === 'status') {
    process.stdout.write(`State: ${stateFilePath()}\nServer: ${state.serverUrl}\nDevice: ${state.deviceId}\nWorkspaces: ${state.workspaces.length}\n`);
    if (state.tokens) {
      const devices = await fetchDeviceStatus(state).catch(() => []);
      const device = devices.find((item) => item.deviceId === state.deviceId);
      process.stdout.write(`Authenticated: yes\nConnected: ${device?.connected === true ? 'yes' : 'no'}\n`);
    } else process.stdout.write('Authenticated: no\nConnected: no\n');
    return;
  }
  if (command === 'workspaces') {
    listWorkspaces(state);
    return;
  }
  if (command === 'remove-workspace') {
    const id = args[1];
    if (!id) throw new Error('Usage: agent-runtime remove-workspace <workspace-id>');
    const removed = await removeWorkspace(state, id);
    if (!removed) throw new Error(`Unknown workspace: ${id}`);
    process.stdout.write(`Revoked workspace ${removed.workspaceId}.\n`);
    return;
  }
  if (command === 'workspace') {
    const action = args[1] ?? 'list';
    if (action === 'list') { listWorkspaces(state); return; }
    if (action === 'add') {
      const path = args[2];
      if (!path) throw new Error('Usage: agent-runtime workspace add <absolute-path> [--name <name>]');
      const workspace = await createWorkspaceState(path, option(args, '--name'));
      if (state.workspaces.some((item) => item.rootPath.toLowerCase() === workspace.rootPath.toLowerCase())) {
        throw new Error('Workspace path is already registered.');
      }
      state.workspaces.push(workspace);
      await saveState(state);
      process.stdout.write(`Registered ${workspace.displayName} as ${workspace.workspaceId}.\n`);
      return;
    }
    if (action === 'revoke') {
      const id = args[2];
      const removed = id ? await removeWorkspace(state, id) : undefined;
      if (!removed) throw new Error(`Unknown workspace: ${id ?? ''}`);
      process.stdout.write(`Revoked workspace ${removed.workspaceId}.\n`);
      return;
    }
    if (action === 'grant') {
      const workspace = state.workspaces.find((item) => item.workspaceId === args[2]);
      const permission = args[3] as LocalRuntimePermission | undefined;
      if (!workspace || !permission || !LOCAL_RUNTIME_PERMISSION_KEYS.includes(permission)) {
        throw new Error('Usage: agent-runtime workspace grant <workspace-id> <permission>');
      }
      const localWorkspace = new LocalWorkspace(workspace, { watch: false, index: false });
      localWorkspace.grantPermission(permission, args.includes('--once') ? 'once' : 'persistent');
      localWorkspace.close();
      await saveState(state);
      process.stdout.write(`Granted ${permission} for ${workspace.workspaceId}${args.includes('--once') ? ' for the next invocation' : ''}.\n`);
      return;
    }
    if (action === 'reset-permissions') {
      const workspace = state.workspaces.find((item) => item.workspaceId === args[2]);
      if (!workspace) throw new Error(`Unknown workspace: ${args[2] ?? ''}`);
      workspace.permissions = { ...DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY };
      delete workspace.oneTimePermissions;
      await saveState(state);
      process.stdout.write(`Reset permissions for ${workspace.workspaceId}.\n`);
      return;
    }
    throw new Error(`Unknown workspace action: ${action}`);
  }
  if (command === 'revoke') {
    if (args[1] && args[1] !== 'device') {
      const index = state.workspaces.findIndex((item) => item.workspaceId === args[1]);
      if (index < 0) throw new Error(`Unknown workspace: ${args[1]}`);
      state.workspaces.splice(index, 1);
    } else if (state.tokens) {
      await revokeDevice(state);
      delete state.tokens;
    }
    await saveState(state);
    process.stdout.write('Authorization revoked.\n');
    return;
  }
  if (command === 'install') {
    state.serverUrl = normalizeLocalRuntimeServerUrl(state.serverUrl);
    await saveState(state);
    await installLocalRuntimeProtocolHandler(currentCliInvocation());
    process.stdout.write(`Registered agent-runtime:// for ${state.serverUrl}.\n`);
    return;
  }
  if (command === 'logs') {
    process.stdout.write('The preview CLI writes runtime diagnostics to stdout/stderr. Persistent redacted logs are planned for the signed distribution.\n');
    return;
  }
  printHelp();
}

function listWorkspaces(state: Awaited<ReturnType<typeof loadState>>) {
  if (!state.workspaces.length) { process.stdout.write('No authorized workspaces.\n'); return; }
  for (const workspace of state.workspaces) {
    process.stdout.write(`${workspace.workspaceId}\t${workspace.displayName}\t${workspace.rootPath}\n`);
  }
}

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function startRuntime(state: Awaited<ReturnType<typeof loadState>>) {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Local Runtime stopped by user.'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdout.write(`Starting Local Runtime for ${state.workspaces.length} workspace(s).\n`);
  await runBridge(state, CLI_VERSION, controller.signal);
}

async function upgradeRuntime(state: Awaited<ReturnType<typeof loadState>>, upgradeId: string) {
  if (process.platform !== 'win32') throw new Error('Local Runtime 自动升级当前仅支持 Windows。');
  await refreshUpgradeAccessToken(state);
  if (!state.tokens?.accessToken) throw new Error('Local Runtime 未授权，无法获取升级包。');
  process.stdout.write(`Checking Local Runtime upgrade ${upgradeId}.\n`);
  const response = await fetch(new URL(`/api/local-runtime/upgrades/${encodeURIComponent(upgradeId)}`, state.serverUrl), {
    headers: { authorization: `Bearer ${state.tokens.accessToken}` },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`Local Runtime upgrade manifest failed: HTTP ${response.status}`);
  const envelope = await response.json() as {
    data?: { releaseUrl?: string; sha256?: string; signature?: string; toVersion?: string }
  };
  const manifest = envelope.data;
  if (!manifest?.releaseUrl || !manifest.sha256 || !/^[a-f0-9]{64}$/i.test(manifest.sha256)
    || !manifest.signature || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(manifest.signature.trim())) {
    throw new Error('当前服务端尚未配置完整的签名升级包。');
  }
  process.stdout.write(`Upgrade package ${manifest.toVersion ?? 'target'} is available.\n`);
  const packageResponse = await fetch(manifest.releaseUrl, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!packageResponse.ok) throw new Error(`Local Runtime upgrade package failed: HTTP ${packageResponse.status}`);
  const content = Buffer.from(await packageResponse.arrayBuffer());
  process.stdout.write('Verifying Local Runtime upgrade package.\n');
  if (manifest.sha256) {
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest.toLowerCase() !== manifest.sha256.toLowerCase()) throw new Error('Local Runtime upgrade package checksum failed.');
  }
  const temporaryPackage = join(dirname(stateFilePath()), `.agent-runtime-upgrade-${upgradeId}.exe`);
  await writeFile(temporaryPackage, content, { mode: 0o700 });
  try {
    await verifyAuthenticodeSignature(temporaryPackage, manifest.signature);
    process.stdout.write('Starting Local Runtime installer.\n');
    const installer = spawn(temporaryPackage, ['/S'], { detached: true, windowsHide: true, stdio: 'ignore' });
    installer.unref();
    process.stdout.write(`Started Local Runtime ${manifest.toVersion ?? 'upgrade'} installer.\n`);
  } catch (error) {
    await unlink(temporaryPackage).catch(() => undefined);
    throw error;
  }
}

async function refreshUpgradeAccessToken(state: Awaited<ReturnType<typeof loadState>>) {
  if (!state.tokens?.refreshToken || Date.parse(state.tokens.accessTokenExpiresAt) > Date.now() + 60_000) return;
  const response = await fetch(new URL('/api/local-runtime/device-tokens/refresh', state.serverUrl), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: state.tokens.refreshToken })
  });
  if (!response.ok) throw new Error(`Local Runtime token refresh failed: HTTP ${response.status}`);
  const envelope = await response.json() as { data?: Awaited<ReturnType<typeof loadState>>['tokens'] };
  const tokens = envelope.data;
  if (!tokens?.accessToken || !tokens.refreshToken) throw new Error('Local Runtime token refresh returned invalid credentials.');
  state.tokens = tokens;
  await saveState(state);
}

async function verifyAuthenticodeSignature(path: string, expectedThumbprint: string) {
  await new Promise<void>((resolve, reject) => {
    const script = [
      '$signature = Get-AuthenticodeSignature -LiteralPath $env:AGENT_RUNTIME_UPGRADE_PATH',
      'if ($signature.Status -ne "Valid") { exit 2 }',
      'if ($env:AGENT_RUNTIME_UPGRADE_SIGNATURE -and $signature.SignerCertificate.Thumbprint -ne $env:AGENT_RUNTIME_UPGRADE_SIGNATURE) { exit 3 }'
    ].join(';');
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
    ], {
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        AGENT_RUNTIME_UPGRADE_PATH: path,
        AGENT_RUNTIME_UPGRADE_SIGNATURE: expectedThumbprint.replace(/\s+/g, '').toUpperCase()
      }
    });
    child.once('error', () => reject(new Error('无法验证 Local Runtime 安装包的 Windows 签名。')));
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error('Local Runtime 安装包签名校验失败。'));
    });
  });
}

function currentCliInvocation() {
  const cliEntry = fileURLToPath(import.meta.url);
  if (!cliEntry.endsWith('.ts')) {
    return { executable: process.execPath, args: [cliEntry] };
  }
  const require = createRequire(import.meta.url);
  const tsxCli = resolve(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
  return { executable: process.execPath, args: [tsxCli, cliEntry] };
}

function printHelp() {
  process.stdout.write([
    'Usage: agent-runtime <command>',
    '',
    'Commands:',
    '  login [--server <url>] [--approve --admin-token <token>]',
    '  start',
    '  status',
    '  version',
    '  workspace add|list|revoke|grant [--once]|reset-permissions',
    '  remove-workspace <workspace-id>',
    '  workspaces',
    '  revoke [device|workspace-id]',
    '  install [--server <url>]',
    '  upgrade <upgrade-id>',
    '  logs',
    ''
  ].join('\n'));
}
