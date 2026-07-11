import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeService, type RuntimeInvocationLog } from '../runtimes/runtime.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { RuntimeRegistryService } from '../runtimes/runtime-registry.service.js';
import { MockRuntimeService } from '../runtimes/mock-runtime.service.js';
import { GenericLlmRuntimeService } from '../runtimes/generic-llm-runtime.service.js';
import { CodexRuntimeAdapterService } from '../runtimes/codex-runtime-adapter.service.js';
import { ClaudeCodeRuntimeAdapterService } from '../runtimes/claude-code-runtime-adapter.service.js';
import { CodeReaderRuntimeAdapterService } from '../runtimes/code-reader-runtime-adapter.service.js';
import { TestRunnerRuntimeAdapterService } from '../runtimes/test-runner-runtime-adapter.service.js';

type PriorInvocationResult = { cliSessionId?: string; workDir?: string } | undefined;

function findPriorInvocation(
  invocations: RuntimeInvocationLog[],
  sessionId: string,
  agentId: string,
  taskId: string
): PriorInvocationResult {
  const candidates = invocations
    .filter(
      (inv) =>
        inv.sessionId === sessionId &&
        inv.agentId === agentId &&
        inv.taskId === taskId &&
        inv.status === 'completed'
    )
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  const latest = candidates[0];
  if (!latest) return undefined;
  return {
    cliSessionId: latest.cliSessionId,
    workDir: latest.workDir
  };
}

function createRuntimeService(invocations: RuntimeInvocationLog[]): RuntimeService {
  const persistence = {
    getCollection: (key: string) => {
      if (key === 'runtimeInvocationsBySession') {
        const grouped = invocations.reduce((acc, inv) => {
          if (!acc[inv.sessionId]) acc[inv.sessionId] = [];
          acc[inv.sessionId].push(inv);
          return acc;
        }, {} as Record<string, RuntimeInvocationLog[]>);
        return grouped;
      }
      return {};
    }
  } as unknown as PersistenceService;

  const registry = {
    registerAdapter: () => Promise.resolve()
  } as unknown as RuntimeRegistryService;

  const mockRuntime = {} as MockRuntimeService;
  const genericLlmRuntime = {} as GenericLlmRuntimeService;
  const codexRuntime = {} as CodexRuntimeAdapterService;
  const claudeCodeRuntime = {} as ClaudeCodeRuntimeAdapterService;
  const codeReaderRuntime = {} as CodeReaderRuntimeAdapterService;
  const testRunnerRuntime = {} as TestRunnerRuntimeAdapterService;

  return new RuntimeService(
    persistence,
    registry,
    mockRuntime,
    genericLlmRuntime,
    codexRuntime,
    claudeCodeRuntime,
    codeReaderRuntime,
    testRunnerRuntime
  );
}

describe('orchestrator-resume-lookup', () => {
  it('无历史 invocation → undefined', () => {
    const runtimeService = createRuntimeService([]);
    const result = runtimeService.findPriorInvocation('sess1', 'agent1', 'task1');
    assert.equal(result, undefined);
  });

  it('有 1 条 completed → 返回其 cliSessionId/workDir', () => {
    const logs: RuntimeInvocationLog[] = [
      {
        id: 'inv1',
        runId: 'run1',
        sessionId: 'sess1',
        taskId: 'task1',
        agentId: 'agent1',
        agentKey: 'key1',
        runtimeType: 'codex',
        phase: 'task_execution',
        status: 'completed',
        contextPack: {
          workingDirectory: { kind: 'server_local', id: 'wd1', name: 'root', path: '/root', selectedAt: '2026-01-01T00:00:00Z' },
          budget: { maxInputTokens: 1000 }
        } as any,
        expectedOutput: { kind: 'agent_message', schemaVersion: '0.1' },
        cliSessionId: 's1',
        workDir: '/work',
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:01:00Z'
      }
    ];
    const runtimeService = createRuntimeService(logs);
    const result = runtimeService.findPriorInvocation('sess1', 'agent1', 'task1');
    assert.deepEqual(result, { cliSessionId: 's1', workDir: '/work' });
  });

  it('有多条：最近的一条 completed 胜出', () => {
    const logs: RuntimeInvocationLog[] = [
      {
        id: 'inv1',
        runId: 'run1',
        sessionId: 'sess1',
        taskId: 'task1',
        agentId: 'agent1',
        agentKey: 'key1',
        runtimeType: 'codex',
        phase: 'task_execution',
        status: 'completed',
        contextPack: {
          workingDirectory: { kind: 'server_local', id: 'wd1', name: 'root', path: '/root', selectedAt: '2026-01-01T00:00:00Z' },
          budget: { maxInputTokens: 1000 }
        } as any,
        expectedOutput: { kind: 'agent_message', schemaVersion: '0.1' },
        cliSessionId: 's1',
        workDir: '/work1',
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:01:00Z'
      },
      {
        id: 'inv2',
        runId: 'run2',
        sessionId: 'sess1',
        taskId: 'task1',
        agentId: 'agent1',
        agentKey: 'key1',
        runtimeType: 'codex',
        phase: 'task_execution',
        status: 'failed',
        contextPack: {
          workingDirectory: { kind: 'server_local', id: 'wd1', name: 'root', path: '/root', selectedAt: '2026-01-01T00:00:00Z' },
          budget: { maxInputTokens: 1000 }
        } as any,
        expectedOutput: { kind: 'agent_message', schemaVersion: '0.1' },
        cliSessionId: 's2',
        workDir: '/work2',
        startedAt: '2026-01-01T00:02:00Z',
        completedAt: '2026-01-01T00:03:00Z'
      },
      {
        id: 'inv3',
        runId: 'run3',
        sessionId: 'sess1',
        taskId: 'task1',
        agentId: 'agent1',
        agentKey: 'key1',
        runtimeType: 'codex',
        phase: 'task_execution',
        status: 'completed',
        contextPack: {
          workingDirectory: { kind: 'server_local', id: 'wd1', name: 'root', path: '/root', selectedAt: '2026-01-01T00:00:00Z' },
          budget: { maxInputTokens: 1000 }
        } as any,
        expectedOutput: { kind: 'agent_message', schemaVersion: '0.1' },
        cliSessionId: 's3',
        workDir: '/work3',
        startedAt: '2026-01-01T00:04:00Z',
        completedAt: '2026-01-01T00:05:00Z'
      }
    ];
    const runtimeService = createRuntimeService(logs);
    const result = runtimeService.findPriorInvocation('sess1', 'agent1', 'task1');
    assert.deepEqual(result, { cliSessionId: 's3', workDir: '/work3' });
  });

  it('跨 session 的同 (agentId, taskId) 不复用', () => {
    const logs: RuntimeInvocationLog[] = [
      {
        id: 'inv1',
        runId: 'run1',
        sessionId: 'sess1',
        taskId: 'task1',
        agentId: 'agent1',
        agentKey: 'key1',
        runtimeType: 'codex',
        phase: 'task_execution',
        status: 'completed',
        contextPack: {
          workingDirectory: { kind: 'server_local', id: 'wd1', name: 'root', path: '/root', selectedAt: '2026-01-01T00:00:00Z' },
          budget: { maxInputTokens: 1000 }
        } as any,
        expectedOutput: { kind: 'agent_message', schemaVersion: '0.1' },
        cliSessionId: 's1',
        workDir: '/work1',
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:01:00Z'
      }
    ];
    const runtimeService = createRuntimeService(logs);
    const result = runtimeService.findPriorInvocation('sess2', 'agent1', 'task1');
    assert.equal(result, undefined);
  });
});
