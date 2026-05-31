import { Injectable } from '@nestjs/common';
import type { AgentRunInput, AgentRunResult, AgentRuntimeAdapter } from '@agent-cluster/shared';
import { codexCliCommand, codexRuntimeEnabled, runtimeCliArgs } from '../../common/runtime-config.js';
import { runCliRuntime } from './cli-runtime-adapter.js';
import { ToolExecutorService } from './tool-executor.service.js';

@Injectable()
export class CodexRuntimeAdapterService implements AgentRuntimeAdapter {
  readonly type = 'codex' as const;

  constructor(private readonly toolExecutor: ToolExecutorService) {}

  run(input: AgentRunInput, signal?: AbortSignal): Promise<AgentRunResult> {
    return runCliRuntime(
      {
        runtimeType: 'codex',
        enabledEnvVar: 'CODEX_RUNTIME_ENABLED',
        enabled: codexRuntimeEnabled(),
        command: codexCliCommand(),
        args: runtimeCliArgs('CODEX_CLI_ARGS')
      },
      input,
      this.toolExecutor,
      signal
    );
  }
}
