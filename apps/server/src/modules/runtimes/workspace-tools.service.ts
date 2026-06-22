import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { Injectable } from '@nestjs/common';
import { assertWithinRootRealpath, isSensitivePath, normalizeRelativePath, safeJoin } from '../../common/path-safety.js';

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.css',
  '.scss',
  '.html',
  '.md',
  '.json',
  '.yml',
  '.yaml',
  '.txt'
]);

const KNOWN_TEXT_FILENAMES = new Set([
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'README',
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'nest-cli.json',
  '.gitignore'
]);

const MAX_OUTPUT_BYTES = 32 * 1024;

export type ReadFileInput = { path?: unknown };

export type ReadFileResult = {
  ok: boolean;
  output: string;
  truncated: boolean;
  errorCode?: string;
  errorMessage?: string;
  resolvedPath?: string;
  byteLength?: number;
};

/**
 * Pull-mode workspace tool implementation. Invoked by runtimes that support
 * the custom tool-call protocol (see executing-pull-context-design-v1 §1).
 *
 * Every read is gated by:
 *  - `safeJoin` (no `..` traversal)
 *  - `assertWithinRootRealpath` (symlink follows must land under root)
 *  - `isSensitivePath` (denylist of credential / SSH / cloud / .env files)
 *  - text-file whitelist (binary content is refused, not transcoded)
 *  - 32KB output cap (truncated content is flagged, not silently sliced)
 *
 * All failures return an `ok=false` result with an error code; this method
 * never throws. The caller (an LLM tool loop) feeds the result back to the
 * model so it can self-correct or give up.
 */
@Injectable()
export class WorkspaceToolsService {
  async readFile(rootPath: string, input: ReadFileInput): Promise<ReadFileResult> {
    if (!rootPath) {
      return this.failure('NO_ROOT', 'Workspace root path is not configured for this session.');
    }
    const rawPath = typeof input?.path === 'string' ? input.path : undefined;
    if (!rawPath) {
      return this.failure('INVALID_INPUT', 'read_file requires { "path": "<relative path>" }.');
    }

    const normalized = normalizeRelativePath(rawPath);
    if (!normalized) {
      return this.failure('INVALID_INPUT', 'path must be a non-empty relative path.');
    }

    if (isSensitivePath(normalized)) {
      return this.failure('SENSITIVE_PATH', `Refusing to read sensitive path: ${normalized}`);
    }

    if (!this.isAllowedTextPath(normalized)) {
      return this.failure(
        'NON_TEXT_FILE',
        `Refusing to read non-text or unrecognized file extension: ${normalized}. Add the extension to the whitelist if intentional.`
      );
    }

    let resolvedPath: string;
    try {
      resolvedPath = safeJoin(rootPath, normalized);
    } catch (error) {
      return this.failure('PATH_TRAVERSAL', this.errorMessage(error));
    }

    try {
      resolvedPath = await assertWithinRootRealpath(rootPath, resolvedPath);
    } catch (error) {
      return this.failure('PATH_TRAVERSAL', this.errorMessage(error));
    }

    let stats;
    try {
      stats = await stat(resolvedPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        return this.failure('NOT_FOUND', `File not found: ${normalized}`);
      }
      return this.failure('IO_ERROR', this.errorMessage(error));
    }

    if (!stats.isFile()) {
      return this.failure('NOT_A_FILE', `Path is not a regular file: ${normalized}`);
    }

    let raw: string;
    try {
      raw = await readFile(resolvedPath, 'utf8');
    } catch (error) {
      return this.failure('IO_ERROR', this.errorMessage(error));
    }

    let output = raw;
    let truncated = false;
    const byteLength = Buffer.byteLength(raw, 'utf8');
    if (byteLength > MAX_OUTPUT_BYTES) {
      // Slice on character boundary; leftover bytes are acceptable as long as we
      // signal `truncated` so the model knows the file is incomplete.
      const buf = Buffer.from(raw, 'utf8').subarray(0, MAX_OUTPUT_BYTES);
      output = buf.toString('utf8');
      truncated = true;
    }

    return {
      ok: true,
      output,
      truncated,
      resolvedPath,
      byteLength
    };
  }

  private isAllowedTextPath(path: string): boolean {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.at(-1) ?? '';
    if (KNOWN_TEXT_FILENAMES.has(fileName)) {
      return true;
    }
    const ext = extname(fileName).toLowerCase();
    return TEXT_EXTENSIONS.has(ext);
  }

  private failure(code: string, message: string): ReadFileResult {
    return {
      ok: false,
      output: '',
      truncated: false,
      errorCode: code,
      errorMessage: message
    };
  }

  private errorMessage(error: unknown) {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
