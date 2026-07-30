import 'reflect-metadata';
import type { AgentRuntimeRunHandle } from '@agent-cluster/shared';
import { abortWithTermination, createExecutionTermination } from '../../common/execution-termination.js';
import { ClaudeCodeRuntimeAdapterService } from './claude-code-runtime-adapter.service.js';
import { CodexRuntimeAdapterService } from './codex-runtime-adapter.service.js';
import { InvocationWorkspaceBindingsService } from './invocation-workspace-bindings.service.js';
import type { ServerRuntimeWorkerRequest, ServerRuntimeWorkerResponse } from './server-runtime-worker.protocol.js';
import { WorkdirBriefService } from './streaming/workdir-brief.service.js';

let active: { invocationId: string; controller: AbortController; handle: AgentRuntimeRunHandle } | undefined;

send({ kind: 'worker.ready', payload: { pid: process.pid } });

process.on('message', (message: ServerRuntimeWorkerRequest) => {
  void handleMessage(message).catch((error) => {
    const invocationId = active?.invocationId ?? (message.kind === 'worker.start' ? message.payload.plan.invocationId : message.payload.invocationId);
    send({ kind: 'worker.error', payload: { invocationId, message: error instanceof Error ? error.message : String(error) } });
    process.exitCode = 1;
    setImmediate(() => process.exit());
  });
});

process.on('disconnect', () => {
  if (active) {
    const termination = createExecutionTermination({
      kind: 'service_shutdown',
      source: 'system',
      scope: 'service',
      diagnosticRef: 'runtime_worker_parent_disconnected'
    });
    abortWithTermination(active.controller, termination);
    void active.handle.cancel(termination).finally(() => process.exit(1));
  } else {
    process.exit(0);
  }
});

async function handleMessage(message: ServerRuntimeWorkerRequest) {
  if (message.kind === 'worker.cancel') {
    if (!active || active.invocationId !== message.payload.invocationId) return;
    const termination = message.payload.termination ?? createExecutionTermination({
      kind: 'user_cancelled',
      source: 'user',
      scope: 'invocation'
    });
    abortWithTermination(active.controller, termination);
    await active.handle.cancel(termination);
    return;
  }
  if (active) throw new Error('Server Runtime Worker accepts one invocation only.');
  const { plan, workDir, credential } = message.payload;
  if (plan.executionTarget.executionLocation !== 'server') {
    throw new Error('Server Runtime Worker rejects non-server execution targets.');
  }
  if (!['codex', 'claude_code'].includes(plan.executionTarget.runtimeType)) {
    throw new Error(`Server Runtime Worker does not support ${plan.executionTarget.runtimeType}.`);
  }
  const restoreCredentialEnvironment = credential ? applyRuntimeCredential(plan, credential) : undefined;
  const bindings = new InvocationWorkspaceBindingsService();
  bindings.bindInvocation(plan.invocationId, workDir);
  const brief = new WorkdirBriefService(bindings);
  const adapter = plan.executionTarget.runtimeType === 'codex'
    ? new CodexRuntimeAdapterService(bindings, brief)
    : new ClaudeCodeRuntimeAdapterService(bindings, brief);
  const controller = new AbortController();
  const handle = adapter.start(plan, controller.signal);
  active = { invocationId: plan.invocationId, controller, handle };
  const pump = (async () => {
    for await (const event of handle.events) send({ kind: 'worker.event', payload: event });
  })();
  try {
    const result = await handle.result;
    await pump;
    await sendAndFlush({ kind: 'worker.result', payload: result });
  } finally {
    active = undefined;
    bindings.unbindInvocation(plan.invocationId);
    restoreCredentialEnvironment?.();
    process.disconnect?.();
  }
}

function applyRuntimeCredential(
  plan: import('@agent-cluster/shared').InvocationPlan,
  credential: import('./server-runtime-worker.protocol.js').ServerRuntimeCredential
) {
  const entries = credential.provider === 'anthropic-compatible'
    ? [
        ['ANTHROPIC_BASE_URL', credential.baseUrl],
        ['ANTHROPIC_AUTH_TOKEN', credential.apiKey],
        ['ANTHROPIC_MODEL', credential.model],
        ['ANTHROPIC_DEFAULT_OPUS_MODEL', credential.model],
        ['ANTHROPIC_DEFAULT_SONNET_MODEL', credential.model],
        ['ANTHROPIC_DEFAULT_HAIKU_MODEL', credential.model]
      ]
    : [
        ['OPENAI_BASE_URL', credential.baseUrl],
        ['OPENAI_API_KEY', credential.apiKey],
        ['CODEX_MODEL', credential.model]
      ];
  const expectedRuntime = credential.provider === 'anthropic-compatible' ? 'claude_code' : 'codex';
  if (plan.executionTarget.runtimeType !== expectedRuntime) {
    throw new Error(`Credential protocol ${credential.provider} is incompatible with ${plan.executionTarget.runtimeType}.`);
  }
  const previous = entries.map(([key]) => [key, process.env[key]] as const);
  for (const [key, value] of entries) process.env[key] = value;
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function send(message: ServerRuntimeWorkerResponse) {
  if (process.connected) process.send?.(message);
}

function sendAndFlush(message: ServerRuntimeWorkerResponse) {
  if (!process.connected || !process.send) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
