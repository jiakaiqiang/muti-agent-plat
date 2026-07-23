import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix as posixPath, win32 as win32Path } from 'node:path';
import type { RuntimeError } from '@agent-cluster/shared';
import { classifyClaudeProviderFailure, type ClaudeProcessFailure } from './claude-provider-error.js';

export type ResolvedClaudeCommand = {
  executable: string;
  source: 'configured' | 'native_install' | 'path';
};

type ResolverOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  findOnPath?: (command: string) => string[];
  exists?: (path: string) => boolean;
};

export function resolveClaudeCommand(options: ResolverOptions = {}): ResolvedClaudeCommand {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? win32Path : posixPath;
  const env = options.env ?? process.env;
  const findOnPath = options.findOnPath ?? defaultFindOnPath;
  const exists = options.exists ?? existsSync;
  const configured = env.CLAUDE_CODE_COMMAND?.trim();

  if (configured) {
    if (platform === 'win32') {
      assertWindowsNativeExecutable(configured);
      if (pathApi.isAbsolute(configured)) {
        if (!exists(configured)) throw invocationError('Configured Claude Code executable does not exist.', 'resolve_executable');
        return { executable: pathApi.resolve(configured), source: 'configured' };
      }
      const configuredMatches = findOnPath(configured).filter((candidate) => pathApi.extname(candidate).toLowerCase() === '.exe');
      if (configuredMatches[0]) return { executable: configuredMatches[0], source: 'configured' };
      if (configured.toLowerCase() !== 'claude') {
        throw invocationError('Configured Claude Code command is not a native Windows executable.', 'resolve_executable');
      }
    } else {
      return { executable: configured, source: 'configured' };
    }
  }

  if (platform !== 'win32') return { executable: 'claude', source: 'path' };

  const direct = findOnPath('claude.exe')[0];
  if (direct) return { executable: direct, source: 'path' };

  for (const wrapper of findOnPath('claude.cmd')) {
    const nativeExecutable = pathApi.join(
      pathApi.dirname(wrapper),
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe'
    );
    if (exists(nativeExecutable)) return { executable: nativeExecutable, source: 'native_install' };
  }

  throw invocationError(
    'Claude Code native executable was not found. Configure CLAUDE_CODE_COMMAND with the full path to claude.exe.',
    'resolve_executable'
  );
}

export function invocationError(
  safeMessage: string,
  stage: 'resolve_executable' | 'spawn' | 'argument_validation',
  details: Record<string, unknown> = {}
) {
  const runtimeError: RuntimeError = {
    code: 'RUNTIME_INVOCATION_ERROR',
    message: safeMessage,
    retryable: false,
    details: { provider: 'claude_code', stage, ...details }
  };
  return Object.assign(new Error(safeMessage), { cause: runtimeError, runtimeError });
}

export function sanitizeClaudeProcessError(error: unknown, diagnosticRef: string) {
  const failure = error as ClaudeProcessFailure;
  const providerError = classifyClaudeProviderFailure(failure, diagnosticRef);
  if (providerError) return runtimeError(providerError);
  const stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
  const invalidArguments = /--json-schema is not valid JSON|unknown option|invalid.*(?:argument|schema)/i.test(stderr);
  if (invalidArguments) {
    return invocationError('Claude Code rejected the Runtime invocation arguments.', 'argument_validation', {
      diagnosticRef,
      exitCode: typeof failure.code === 'number' ? failure.code : null,
      signal: typeof failure.signal === 'string' ? failure.signal : null
    });
  }
  return runtimeError({
    code: 'MODEL_ERROR',
    message: 'Claude Code exited before producing a valid Runtime result.',
    retryable: true,
    details: {
      provider: 'claude_code',
      stage: 'process_exit',
      diagnosticRef,
      exitCode: typeof failure.code === 'number' ? failure.code : null,
      signal: typeof failure.signal === 'string' ? failure.signal : null
    }
  });
}

function runtimeError(value: RuntimeError) {
  return Object.assign(new Error(value.message), { cause: value, runtimeError: value });
}

function assertWindowsNativeExecutable(command: string) {
  if (['.cmd', '.bat'].includes(win32Path.extname(command).toLowerCase())) {
    throw invocationError(
      'Claude Code Windows shell wrappers are not supported for structured Runtime arguments; configure claude.exe.',
      'resolve_executable'
    );
  }
}

function defaultFindOnPath(command: string) {
  try {
    return execFileSync('where.exe', [command], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
