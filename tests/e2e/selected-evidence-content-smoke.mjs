import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  startSmokeServer,
  stopSmokeServer
} from './smoke-server.mjs';

await buildServer();

let server;

try {
  server = await startSmokeServer('selected-evidence-content-smoke', {
    DISCUSSION_MAX_ROUNDS: '0'
  });

  const secretContent = 'SECRET_SHOULD_NOT_ENTER_RUNTIME_CONTEXT';
  const targetContent = 'export const answer = 41;';

  const { sessionId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Please update src/target.ts and keep unrelated files out of runtime context.',
    {
      tokenBudget: 50_000,
      workspaceSnapshot: {
        rootName: 'selected-evidence-project',
        scannedAt: new Date().toISOString(),
        fileCount: 4,
        totalBytes: 512,
        tree: [
          { path: 'src/target.ts', kind: 'file' },
          { path: 'src/other.ts', kind: 'file' },
          { path: 'secrets/api-key.txt', kind: 'file' },
          { path: 'package.json', kind: 'file' }
        ],
        files: [
          {
            path: 'src/target.ts',
            size: targetContent.length,
            language: 'typescript',
            content: targetContent
          },
          {
            path: 'src/other.ts',
            size: 22,
            language: 'typescript',
            content: 'export const other = 1;'
          },
          {
            path: 'secrets/api-key.txt',
            size: secretContent.length,
            language: 'text',
            content: secretContent
          },
          {
            path: 'package.json',
            size: 64,
            language: 'json',
            content: '{"scripts":{"typecheck":"tsc --noEmit"}}'
          }
        ],
        skipped: [],
        detectedStack: ['typescript'],
        entrypoints: ['src/target.ts']
      }
    }
  );

  const envelopes = await api(server.apiBase, `/sessions/${sessionId}/debug/context-envelopes`);
  const envelopeItem = [...envelopes.data.items]
    .reverse()
    .find((item) => item.contextEnvelope?.L1.navigation && item.contextEnvelope?.L3.files);
  if (!envelopeItem) {
    throw new Error(`Expected a ContextEnvelope with navigation and selected evidence: ${JSON.stringify(envelopes)}`);
  }

  const envelope = envelopeItem.contextEnvelope;
  const navigationTarget = envelope.L1.navigation.entries.find((file) => file.path === 'src/target.ts');
  if (!navigationTarget || navigationTarget.size !== targetContent.length || Object.hasOwn(navigationTarget, 'content')) {
    throw new Error(`L1 navigation should expose file metadata without content: ${JSON.stringify(navigationTarget)}`);
  }

  const selectedContents = envelope.L3.files;
  const targetEvidence = selectedContents.find((item) => item.path === 'src/target.ts');
  if (!targetEvidence?.content?.includes(targetContent)) {
    throw new Error(`Expected selected evidence content for src/target.ts: ${JSON.stringify(selectedContents)}`);
  }

  const leakedSecret = JSON.stringify(envelope).includes(secretContent);
  if (leakedSecret) {
    throw new Error('Unselected secret file content leaked into ContextEnvelope.');
  }

  console.log('selected evidence content smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
