import { Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type {
  AgentRunResult,
  AgentRuntimeEvent,
  AgentRuntimeRunHandle,
  ExecutionTermination,
  InvocationPlan
} from '@agent-cluster/shared';
import { createAgentMessageOutput } from '@agent-cluster/shared';
import { createExecutionTermination } from '../../common/execution-termination.js';
import { nowIso } from '../../common/time.js';
import type { ServerRuntimeWorkerRequest, ServerRuntimeWorkerResponse } from './server-runtime-worker.protocol.js';
import type { ServerRuntimeCredential } from './server-runtime-worker.protocol.js';
import { modelProviderSupportsRuntime } from '@agent-cluster/shared';
import { RuntimeModelConfigService } from './runtime-model-config.service.js';

type ActiveWorker = {
  child: ChildProcess;
  plan: InvocationPlan;
  queue: RuntimeEventQueue;
  resolve: (result: AgentRunResult) => void;
  settled: boolean;
};

@Injectable()
export class ServerRuntimeWorkerService implements OnModuleDestroy {
  private readonly active = new Map<string, ActiveWorker>();

  constructor(@Optional() private readonly modelConfig?: RuntimeModelConfigService) {}

  start(plan: InvocationPlan, workDir: string): AgentRuntimeRunHandle {
    if (plan.executionTarget.executionLocation !== 'server') {
      return settledHandle(failedResult(plan, 'SERVER_RUNTIME_ROUTE_MISMATCH', 'Server Worker rejects a non-server target.'));
    }
    if (!['codex', 'claude_code'].includes(plan.executionTarget.runtimeType)) {
      return settledHandle(failedResult(plan, 'SERVER_RUNTIME_WORKER_UNSUPPORTED', `Worker does not support ${plan.executionTarget.runtimeType}.`));
    }
    if (!workDir) return settledHandle(failedResult(plan, 'SERVER_RUNTIME_WORKDIR_REQUIRED', 'Server Worker requires an isolated execution directory.'));
    const credential = this.credentialFor(plan);
    if (credential instanceof Error) return settledHandle(failedResult(plan, 'SERVER_RUNTIME_MODEL_INCOMPATIBLE', credential.message));
    if (this.active.has(plan.invocationId)) {
      return settledHandle(failedResult(plan, 'SERVER_RUNTIME_DUPLICATE_INVOCATION', 'Invocation id is already active.'));
    }
    if (this.active.size >= serverRuntimeWorkerMaxConcurrency()) {
      return settledHandle(failedResult(
        plan,
        'SERVER_RUNTIME_CAPACITY_EXCEEDED',
        'Server Runtime Worker capacity is exhausted; retry after an active invocation finishes.'
      ));
    }

    const entry = workerEntry();
    const child = fork(entry, [], {
      cwd: process.cwd(),
      env: buildServerRuntimeWorkerEnvForEntry(entry),
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: serverRuntimeWorkerExecArgv()
    });
    const queue = new RuntimeEventQueue();
    let resolveResult!: (result: AgentRunResult) => void;
    const result = new Promise<AgentRunResult>((resolve) => { resolveResult = resolve; });
    const worker: ActiveWorker = { child, plan, queue, resolve: resolveResult, settled: false };
    this.active.set(plan.invocationId, worker);
    let stderr = '';
    child.stdout?.resume();
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8_000); });
    child.on('message', (message: ServerRuntimeWorkerResponse) => this.handleMessage(worker, message));
    child.on('error', (error) => this.finish(worker, failedResult(plan, 'SERVER_RUNTIME_WORKER_ERROR', error.message)));
    child.on('close', (code, signal) => {
      if (!worker.settled) {
        this.finish(worker, failedResult(
          plan,
          'SERVER_RUNTIME_WORKER_EXITED',
          `Server Runtime Worker exited before producing a result (code=${code ?? 'null'}, signal=${signal ?? 'null'}).${stderr ? ` ${stderr}` : ''}`
        ));
      }
    });
    const request: ServerRuntimeWorkerRequest = { kind: 'worker.start', payload: { plan, workDir, ...(credential ? { credential } : {}) } };
    child.send(request);

    return {
      events: queue,
      result,
      cancel: async (termination) => {
        if (worker.settled) return;
        const resolved = termination ?? createExecutionTermination({
          kind: 'user_cancelled',
          source: 'user',
          scope: 'invocation',
          phase: plan.phase
        });
        const message: ServerRuntimeWorkerRequest = {
          kind: 'worker.cancel',
          payload: { invocationId: plan.invocationId, termination: resolved }
        };
        if (child.connected) child.send(message);
        const timer = setTimeout(() => {
          if (!worker.settled) child.kill();
        }, 5_000);
        timer.unref();
      }
    };
  }

  async onModuleDestroy() {
    const termination = createExecutionTermination({
      kind: 'service_shutdown',
      source: 'system',
      scope: 'service'
    });
    await Promise.all([...this.active.values()].map(async (worker) => {
      if (worker.child.connected) {
        worker.child.send({
          kind: 'worker.cancel',
          payload: { invocationId: worker.plan.invocationId, termination }
        } satisfies ServerRuntimeWorkerRequest);
      }
      await Promise.race([
        new Promise<void>((resolve) => worker.child.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000))
      ]);
      if (!worker.settled) worker.child.kill();
    }));
  }

  activeWorkerCount() {
    return this.active.size;
  }

  activeWorkerPids() {
    return [...this.active.values()].flatMap((worker) =>
      worker.child.pid === undefined ? [] : [worker.child.pid]
    );
  }

  private handleMessage(worker: ActiveWorker, message: ServerRuntimeWorkerResponse) {
    if (worker.settled) return;
    if (message.kind === 'worker.event') {
      if (message.payload.invocationId === worker.plan.invocationId) worker.queue.push(message.payload);
      return;
    }
    if (message.kind === 'worker.result') {
      if (message.payload.invocationId !== worker.plan.invocationId) {
        this.finish(worker, failedResult(worker.plan, 'SERVER_RUNTIME_WORKER_PROTOCOL_ERROR', 'Worker result invocationId mismatch.'));
      } else {
        this.finish(worker, message.payload);
      }
      return;
    }
    if (message.kind === 'worker.error') {
      this.finish(worker, failedResult(worker.plan, 'SERVER_RUNTIME_WORKER_ERROR', message.payload.message));
    }
  }

  private finish(worker: ActiveWorker, result: AgentRunResult) {
    if (worker.settled) return;
    worker.settled = true;
    this.active.delete(worker.plan.invocationId);
    worker.queue.close();
    worker.resolve(result);
    if (worker.child.connected) worker.child.disconnect();
  }

  private credentialFor(plan: InvocationPlan): ServerRuntimeCredential | Error | undefined {
    if (!plan.executionTarget.modelId) return undefined;
    if (!this.modelConfig) return new Error('Model configuration service is unavailable.');
    const connection = this.modelConfig.connectionForModelId(plan.executionTarget.modelId);
    if (connection.credentialLocation !== 'server') {
      return new Error('A locally stored credential cannot be used for server execution.');
    }
    if (!modelProviderSupportsRuntime(connection.provider, plan.executionTarget.runtimeType)) {
      return new Error(`Model protocol ${connection.provider} is incompatible with ${plan.executionTarget.runtimeType}.`);
    }
    if (!connection.baseUrl || !connection.apiKey) {
      return new Error('The selected server model is missing its endpoint or API key.');
    }
    if (connection.provider === 'ollama') {
      return new Error('Ollama connections are only supported by Generic LLM.');
    }
    return {
      provider: connection.provider,
      baseUrl: connection.baseUrl,
      model: connection.model,
      apiKey: connection.apiKey
    };
  }
}

export function serverRuntimeWorkerMaxConcurrency() {
  return positiveIntegerSetting('AGENT_CLUSTER_SERVER_RUNTIME_MAX_CONCURRENCY', 4, 1, 64);
}

export function serverRuntimeWorkerMaxOldSpaceMb() {
  return positiveIntegerSetting('AGENT_CLUSTER_SERVER_RUNTIME_MAX_OLD_SPACE_MB', 512, 128, 8_192);
}

export function serverRuntimeWorkerExecArgv(source: string[] = process.execArgv) {
  return [
    ...source.filter((argument) => !argument.startsWith('--max-old-space-size=')),
    `--max-old-space-size=${serverRuntimeWorkerMaxOldSpaceMb()}`
  ];
}

function positiveIntegerSetting(name: string, fallback: number, min: number, max: number) {
  const configured = Number(process.env[name] ?? fallback);
  return Number.isInteger(configured) && configured >= min && configured <= max ? configured : fallback;
}

const WORKER_ENV_EXACT_ALLOWLIST = new Set([
  'AGENT_CLUSTER_BRIEF_STAGING_DIR',
  'AGENT_CLUSTER_BRIEF_TTL_MS',
  'AGENT_CLUSTER_DATA_DIR',
  'AGENT_CLUSTER_WORKDIR_BRIEF',
  'ANTHROPIC_API_KEY',
  'APPDATA',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'COLORTERM',
  'COMSPEC',
  'HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'NO_PROXY',
  'OPENAI_API_KEY',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'RUNTIME_STREAMING',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'USERPROFILE',
  'WINDIR'
]);

const WORKER_ENV_PREFIX_ALLOWLIST = ['CLAUDE_CODE_', 'CODEX_RUNTIME_'];

export function buildServerRuntimeWorkerEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { AGENT_CLUSTER_RUNTIME_WORKER: 'true' };
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toUpperCase();
    if (
      value !== undefined &&
      (WORKER_ENV_EXACT_ALLOWLIST.has(normalized) ||
        WORKER_ENV_PREFIX_ALLOWLIST.some((prefix) => normalized.startsWith(prefix)))
    ) {
      env[key] = value;
    }
  }
  return env;
}

function buildServerRuntimeWorkerEnvForEntry(entry: string): NodeJS.ProcessEnv {
  const env = buildServerRuntimeWorkerEnv();
  if (entry.endsWith('.ts')) {
    env.TSX_TSCONFIG_PATH = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url));
  }
  return env;
}

function workerEntry() {
  const current = fileURLToPath(import.meta.url);
  return fileURLToPath(new URL(current.endsWith('.ts') ? './server-runtime-worker.process.ts' : './server-runtime-worker.process.js', import.meta.url));
}

function failedResult(plan: InvocationPlan, code: string, message: string): AgentRunResult {
  return {
    invocationId: plan.invocationId,
    runtimeType: plan.executionTarget.runtimeType,
    status: 'failed',
    output: createAgentMessageOutput({ messageKind: 'risk', content: message }),
    events: [],
    artifacts: [],
    systemEvidence: {
      workspaceChangeSet: null,
      verifiedTestResults: [],
      capturedAt: nowIso(),
      invocationId: plan.invocationId
    },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: plan.executionTarget.modelId ?? plan.executionTarget.runtimeType },
    error: {
      code: 'RUNTIME_INVOCATION_ERROR',
      message: `${code}: ${message}`,
      retryable: false,
      details: { workerCode: code }
    }
  };
}

class RuntimeEventQueue implements AsyncIterable<AgentRuntimeEvent> {
  private readonly values: AgentRuntimeEvent[] = [];
  private readonly waiters: Array<(value: IteratorResult<AgentRuntimeEvent>) => void> = [];
  private closed = false;
  push(event: AgentRuntimeEvent) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else this.values.push(event);
  }
  close() {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()?.({ done: true, value: undefined });
  }
  [Symbol.asyncIterator](): AsyncIterator<AgentRuntimeEvent> {
    return { next: () => {
      const value = this.values.shift();
      if (value) return Promise.resolve({ done: false, value });
      if (this.closed) return Promise.resolve({ done: true, value: undefined });
      return new Promise((resolve) => this.waiters.push(resolve));
    } };
  }
}

function settledHandle(result: AgentRunResult): AgentRuntimeRunHandle {
  return { events: { async *[Symbol.asyncIterator]() {} }, result: Promise.resolve(result), cancel: async () => {} };
}
