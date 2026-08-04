import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWindowsProtocolCommand,
  installLocalRuntimeProtocolHandler,
  normalizeLocalRuntimeServerUrl,
  parseLocalRuntimeLaunchUrl,
  updateTrustedLocalRuntimeServer
} from './protocol-handler.js';

test('accepts HTTPS origins and loopback HTTP origins', () => {
  assert.equal(normalizeLocalRuntimeServerUrl('https://agent.example.com/'), 'https://agent.example.com');
  assert.equal(normalizeLocalRuntimeServerUrl('http://127.0.0.1:8099'), 'http://127.0.0.1:8099');
});

test('rejects insecure remote servers and URLs with credentials or paths', () => {
  assert.throws(() => normalizeLocalRuntimeServerUrl('http://agent.example.com'), /must use HTTPS/);
  assert.throws(() => normalizeLocalRuntimeServerUrl('https://user:secret@agent.example.com'), /credentials/);
  assert.throws(() => normalizeLocalRuntimeServerUrl('https://agent.example.com/platform'), /only an origin/);
});

test('only launches the server registered in local state', () => {
  const trusted = 'https://agent.example.com';
  assert.deepEqual(parseLocalRuntimeLaunchUrl(
    'agent-runtime://connect?server=https%3A%2F%2Fagent.example.com',
    trusted
  ), { serverUrl: trusted });
  assert.throws(() => parseLocalRuntimeLaunchUrl(
    'agent-runtime://connect?server=https%3A%2F%2Fevil.example.com',
    trusted
  ), /does not match/);
});

test('clears credentials when the explicitly configured server changes', () => {
  const state = { serverUrl: 'https://old.example.com', tokens: { accessToken: 'secret' } };
  updateTrustedLocalRuntimeServer(state, 'https://new.example.com');
  assert.equal(state.serverUrl, 'https://new.example.com');
  assert.equal(state.tokens, undefined);
});

test('quotes a Windows CLI invocation without using a shell', () => {
  assert.equal(buildWindowsProtocolCommand({
    executable: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\Agent Runtime\\cli.js']
  }), '"C:\\Program Files\\nodejs\\node.exe" "C:\\Agent Runtime\\cli.js" launch-uri "%1"');
});

test('registers the custom protocol under the current user', async () => {
  const commands: string[][] = [];
  await installLocalRuntimeProtocolHandler(
    { executable: 'node.exe', args: ['cli.js'] },
    {
      platform: 'win32',
      runRegistryCommand: async (args) => {
        commands.push([...args]);
      }
    }
  );

  assert.equal(commands.length, 3);
  assert.ok(commands[0]?.includes('HKCU\\Software\\Classes\\agent-runtime'));
  assert.match(commands[2]?.at(-2) ?? '', /launch-uri "%1"/);
});
