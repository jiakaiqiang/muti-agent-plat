import { Injectable } from '@nestjs/common';
import type { AgentRunInput, AgentRunResult, AgentRuntimeAdapter } from '@agent-cluster/shared';
import { claudeCodeCliCommand, claudeCodeRuntimeEnabled, runtimeCliArgs } from '../../common/runtime-config.js';
import { runCliRuntime } from './cli-runtime-adapter.js';
import { ToolExecutorService } from './tool-executor.service.js';

@Injectable()
export class ClaudeCodeRuntimeAdapterService implements AgentRuntimeAdapter {
  readonly type = 'claude_code' as const;

  constructor(private readonly toolExecutor: ToolExecutorService) {}

  run(input: AgentRunInput, signal?: AbortSignal): Promise<AgentRunResult> {
    return runCliRuntime(
      {
        runtimeType: 'claude_code',
        enabledEnvVar: 'CLAUDE_CODE_RUNTIME_ENABLED',
        enabled: claudeCodeRuntimeEnabled(),
        command: claudeCodeCliCommand(),
        args: runtimeCliArgs('CLAUDE_CODE_CLI_ARGS')
      },
      input,
      this.toolExecutor,
      signal
    );
  }
}
