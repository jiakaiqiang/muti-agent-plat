import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const debugView = readFileSync(join(root, 'apps/web/src/components/DebugRuntimeView.vue'), 'utf8');
const debugController = readFileSync(join(root, 'apps/server/src/modules/debug/debug.controller.ts'), 'utf8');

function requirePattern(source, pattern, label) {
  if (!pattern.test(source)) throw new Error(`Missing ${label}: ${pattern}`);
}

function forbidPattern(source, pattern, label) {
  if (pattern.test(source)) throw new Error(`Found obsolete ${label}: ${pattern}`);
}

requirePattern(debugController, /@Get\('context-envelopes'\)/, 'ContextEnvelope debug endpoint');
requirePattern(debugController, /contextEnvelopes\(/, 'ContextEnvelope controller method');
requirePattern(debugController, /contextEnvelope: invocation\.contextEnvelope/, 'authoritative envelope payload');
requirePattern(debugController, /identity: invocation\.profileSnapshot/, 'compiled identity snapshot');
requirePattern(debugController, /executionTarget: invocation\.executionTarget/, 'resolved execution target');
requirePattern(debugController, /toolCatalog: invocation\.toolCatalog/, 'Tool Authority catalog');
requirePattern(debugController, /memoryBulletCount: invocation\.contextEnvelope\.L5\.bullets\.length/, 'L5 memory summary');
requirePattern(debugController, /artifactRefCount:/, 'L6 artifact summary');

requirePattern(debugView, /ContextEnvelopeV2/, 'ContextEnvelope view contract');
for (const layer of ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']) {
  requirePattern(debugView, new RegExp(`contextEnvelope\\.${layer}`), `${layer} rendering`);
}
requirePattern(debugView, /selectedInvocation\.identity/, 'identity rendering');
requirePattern(debugView, /selectedInvocation\.executionTarget/, 'execution target rendering');
requirePattern(debugView, /selectedInvocation\.toolCatalog/, 'tool authority rendering');

const obsoleteAssemblyName = new RegExp(['context', 'Assembl'].join(''), 'i');
forbidPattern(debugController, /context-packs|contextPacks/, 'old context API');
forbidPattern(debugController, obsoleteAssemblyName, 'old context controller model');
forbidPattern(debugView, /ContextPack|contextPack/, 'old context view model');
forbidPattern(debugView, obsoleteAssemblyName, 'old context view model');

console.log('debug ContextEnvelope view smoke ok');
