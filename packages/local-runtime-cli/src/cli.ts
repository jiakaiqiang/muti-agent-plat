#!/usr/bin/env node
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { loadState, saveState, stateFilePath } from './state.js';

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
    parseLocalRuntimeLaunchUrl(launchUrl, state.serverUrl);
    await startRuntime(state);
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
      const index = state.workspaces.findIndex((item) => item.workspaceId === id);
      if (index < 0) throw new Error(`Unknown workspace: ${id}`);
      const [removed] = state.workspaces.splice(index, 1);
      await saveState(state);
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
    '  workspaces',
    '  revoke [device|workspace-id]',
    '  install [--server <url>]',
    '  logs',
    ''
  ].join('\n'));
}
