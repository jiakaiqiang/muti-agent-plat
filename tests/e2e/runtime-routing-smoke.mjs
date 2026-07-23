import { api, buildServer, startSmokeServer, stopSmokeServer } from './smoke-server.mjs';

await buildServer();

let server;

try {
  server = await startSmokeServer('runtime-routing-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    REQUIRE_USER_CONFIRMATION: 'false'
  });

  const preferred = await createSession(server.apiBase, {
    preferredRuntimeType: 'generic_llm',
    preferredModelId: 'audit-model',
    allowedRuntimeTypes: ['generic_llm', 'codex', 'generic_llm']
  });
  assertPreference(preferred, {
    preferredRuntimeType: 'generic_llm',
    preferredModelId: 'audit-model',
    allowedRuntimeTypes: ['generic_llm', 'codex']
  });

  const fetched = (await api(server.apiBase, `/sessions/${preferred.id}`)).data;
  assertPreference(fetched, preferred.runtimePreference);

  for (const session of [preferred, fetched]) {
    if ('executionTarget' in session || 'engineeringRuntime' in session || 'contextPipelineVersion' in session) {
      throw new Error(`Session must not persist a Runtime target or old routing contract: ${JSON.stringify(session)}`);
    }
    if (!session.dataEpoch) {
      throw new Error(`Session must carry the active v2 dataEpoch: ${JSON.stringify(session)}`);
    }
  }

  console.log('runtime routing API boundary smoke ok');
} finally {
  if (server) await stopSmokeServer(server);
}

async function createSession(apiBase, runtimePreference) {
  const created = await api(apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: 'Create a v2 Session with a non-authoritative Runtime preference.',
      agentIds: ['coordinator', 'requirements', 'architect'],
      runtimePreference
    })
  });
  return created.data.session;
}

function assertPreference(session, expected) {
  if (JSON.stringify(session.runtimePreference) !== JSON.stringify(expected)) {
    throw new Error(`Runtime preference mismatch: ${JSON.stringify({ expected, actual: session.runtimePreference })}`);
  }
}
