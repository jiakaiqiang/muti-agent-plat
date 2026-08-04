import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROTOCOL_NAME = 'agent-runtime';

export type LocalRuntimeCliInvocation = {
  executable: string;
  args: readonly string[];
};

type RegistryCommandRunner = (args: readonly string[]) => Promise<void>;

export function normalizeLocalRuntimeServerUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Local Runtime server must use HTTP or HTTPS.');
  }
  if (url.username || url.password) {
    throw new Error('Local Runtime server URL must not contain credentials.');
  }
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('Local Runtime server URL must contain only an origin.');
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new Error('Remote Local Runtime servers must use HTTPS.');
  }
  return url.origin;
}

export function updateTrustedLocalRuntimeServer(
  state: { serverUrl: string; tokens?: unknown },
  value: string
) {
  const nextServerUrl = normalizeLocalRuntimeServerUrl(value);
  if (normalizeLocalRuntimeServerUrl(state.serverUrl) !== nextServerUrl) delete state.tokens;
  state.serverUrl = nextServerUrl;
  return nextServerUrl;
}

export function parseLocalRuntimeLaunchUrl(value: string, trustedServerUrl: string) {
  const url = new URL(value);
  if (url.protocol !== `${PROTOCOL_NAME}:` || url.hostname !== 'connect' || url.pathname !== '') {
    throw new Error('Unsupported Local Runtime launch URL.');
  }
  const requestedServer = normalizeLocalRuntimeServerUrl(url.searchParams.get('server') ?? '');
  const trustedServer = normalizeLocalRuntimeServerUrl(trustedServerUrl);
  if (requestedServer !== trustedServer) {
    throw new Error('Local Runtime launch URL does not match the installed server.');
  }
  return { serverUrl: requestedServer };
}

export function buildWindowsProtocolCommand(invocation: LocalRuntimeCliInvocation) {
  return [
    quoteWindowsArgument(invocation.executable),
    ...invocation.args.map(quoteWindowsArgument),
    'launch-uri',
    '"%1"'
  ].join(' ');
}

export async function installLocalRuntimeProtocolHandler(
  invocation: LocalRuntimeCliInvocation,
  options: {
    platform?: NodeJS.Platform;
    runRegistryCommand?: RegistryCommandRunner;
  } = {}
) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    throw new Error('Automatic agent-runtime:// registration is currently supported on Windows only.');
  }

  const rootKey = `HKCU\\Software\\Classes\\${PROTOCOL_NAME}`;
  const command = buildWindowsProtocolCommand(invocation);
  const runRegistryCommand = options.runRegistryCommand ?? defaultRegistryCommand;
  const commands = [
    ['add', rootKey, '/ve', '/t', 'REG_SZ', '/d', 'URL:Agent Runtime Protocol', '/f'],
    ['add', rootKey, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f'],
    ['add', `${rootKey}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', command, '/f']
  ] as const;

  for (const args of commands) await runRegistryCommand(args);
}

export function quoteWindowsArgument(value: string) {
  if (value && !/[\s"]/u.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;

  for (const character of value) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += '\\'.repeat(backslashes) + character;
    backslashes = 0;
  }

  return quoted + '\\'.repeat(backslashes * 2) + '"';
}

function isLoopbackHost(hostname: string) {
  return ['localhost', '127.0.0.1', '::1'].includes(hostname.toLowerCase());
}

async function defaultRegistryCommand(args: readonly string[]) {
  await execFileAsync('reg.exe', [...args], { windowsHide: true });
}
