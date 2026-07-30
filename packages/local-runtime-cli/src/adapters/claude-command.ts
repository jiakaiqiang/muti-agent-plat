import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';

export type ResolvedClaudeCommand = {
  executable: string;
  shell: false;
  source: 'configured' | 'native_install' | 'path';
};

export function resolveClaudeCommand(): ResolvedClaudeCommand {
  const configured = process.env.AGENT_RUNTIME_CLAUDE_COMMAND?.trim()
    || process.env.CLAUDE_CODE_COMMAND?.trim();
  if (process.platform !== 'win32') {
    return { executable: configured || 'claude', shell: false, source: configured ? 'configured' : 'path' };
  }

  if (configured) {
    assertNativeWindowsCommand(configured);
    if (isAbsolute(configured)) {
      if (!existsSync(configured)) throw new Error('LOCAL_RUNTIME_CLAUDE_NOT_FOUND: configured claude.exe does not exist.');
      return { executable: resolve(configured), shell: false, source: 'configured' };
    }
    const configuredMatch = findOnPath(configured).find((candidate) => extname(candidate).toLowerCase() === '.exe');
    if (configuredMatch) return { executable: configuredMatch, shell: false, source: 'configured' };
    if (configured.toLowerCase() !== 'claude') {
      throw new Error('LOCAL_RUNTIME_CLAUDE_NOT_FOUND: configured command is not a native Windows executable.');
    }
  }

  const direct = findOnPath('claude.exe')[0];
  if (direct) return { executable: direct, shell: false, source: 'path' };
  for (const wrapper of findOnPath('claude.cmd')) {
    const nativeExecutable = join(
      dirname(wrapper),
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe'
    );
    if (existsSync(nativeExecutable)) {
      return { executable: nativeExecutable, shell: false, source: 'native_install' };
    }
  }
  throw new Error(
    'LOCAL_RUNTIME_CLAUDE_NOT_FOUND: Claude Code native executable was not found. '
      + 'Configure AGENT_RUNTIME_CLAUDE_COMMAND with the full path to claude.exe.'
  );
}

function assertNativeWindowsCommand(command: string) {
  if (['.cmd', '.bat'].includes(extname(command).toLowerCase())) {
    throw new Error(
      'LOCAL_RUNTIME_CLAUDE_WRAPPER_UNSUPPORTED: configure the native claude.exe instead of a .cmd or .bat wrapper.'
    );
  }
}

function findOnPath(command: string) {
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
