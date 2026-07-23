import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative } from 'node:path';
import type {
  SessionWorkingDirectory,
  WorkspaceFileSnapshot,
  WorkspaceManifestCoverage,
  WorkspaceSkippedReason,
  WorkspaceSnapshot,
  WorkspaceTreeNode
} from '@agent-cluster/shared';
import { isGeneratedWorkspaceDirectory } from '@agent-cluster/shared';
import { nowIso } from './time.js';
import { isSensitivePath } from './path-safety.js';

const textExtensions = new Set(['.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.yml', '.yaml', '.txt']);
const configFileNames = new Set(['AGENTS.md', 'CLAUDE.md', 'README.md', 'package.json', 'tsconfig.json', 'vite.config.ts', 'vite.config.js', 'nest-cli.json']);
const ruleFileNames = new Set(['agents.md', 'claude.md']);
const sourceExtensions = new Set(['.css', '.html', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue']);
const maxScannedEntries = 350;
const maxReadableFiles = 80;
const maxSingleFileBytes = 80_000;
const maxTotalContentBytes = 550_000;

export async function scanServerWorkspace(rootPath: string): Promise<{
  workingDirectory: SessionWorkingDirectory;
  workspaceSnapshot: WorkspaceSnapshot;
}> {
  if (!isAbsolute(rootPath)) {
    throw new Error(`工作区路径必须是绝对路径：${rootPath}`);
  }
  const rootStat = await stat(rootPath);
  if (!rootStat.isDirectory()) {
    throw new Error(`工作区路径不是目录：${rootPath}`);
  }

  const files: WorkspaceFileSnapshot[] = [];
  const readableCandidates: Array<{ path: string; absolutePath: string; size: number }> = [];
  const skipped: WorkspaceSnapshot['skipped'] = [];
  const tree: WorkspaceTreeNode[] = [];
  let totalBytes = 0;
  let entryCount = 0;
  let totalEntriesSeen = 0;
  let readableCount = 0;
  let totalContentBytes = 0;
  let generatedSkipped = 0;

  async function scan(currentPath: string, target: WorkspaceTreeNode[]) {
    const entries = await readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = join(currentPath, entry.name);
      const path = relative(rootPath, absolutePath).replace(/\\/g, '/');
      totalEntriesSeen += 1;
      if (entryCount >= maxScannedEntries) {
        skipped.push({ path, reason: 'limit_exceeded' });
        continue;
      }
      entryCount += 1;

      if (entry.isDirectory()) {
        const node: WorkspaceTreeNode = { path, kind: 'directory', children: [] };
        target.push(node);
        if (isGeneratedWorkspaceDirectory(entry.name)) {
          generatedSkipped += 1;
          skipped.push({ path, reason: 'ignored_directory' });
          continue;
        }
        await scan(absolutePath, node.children ?? []);
        continue;
      }

      const node: WorkspaceTreeNode = { path, kind: 'file' };
      target.push(node);
      if (isSensitivePath(path)) {
        skipped.push({ path, reason: 'sensitive' });
        continue;
      }

      try {
        const fileStat = await stat(absolutePath);
        totalBytes += fileStat.size;
        if (!shouldReadTextFile(path)) {
          skipped.push({ path, reason: 'binary' });
          continue;
        }
        if (fileStat.size > maxSingleFileBytes) {
          skipped.push({ path, reason: 'too_large', detail: `${fileStat.size} bytes` });
          continue;
        }
        readableCandidates.push({ path, absolutePath, size: fileStat.size });
      } catch (error) {
        skipped.push({ path, reason: 'read_error', detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  await scan(rootPath, tree);
  readableCandidates.sort(
    (left, right) => workspaceFileScanPriority(left.path) - workspaceFileScanPriority(right.path) || left.path.localeCompare(right.path)
  );
  for (const candidate of readableCandidates) {
    if (readableCount >= maxReadableFiles || totalContentBytes + candidate.size > maxTotalContentBytes) {
      skipped.push({ path: candidate.path, reason: 'limit_exceeded' });
      continue;
    }
    try {
      const content = await readFile(candidate.absolutePath, 'utf8');
      readableCount += 1;
      totalContentBytes += content.length;
      files.push({
        path: candidate.path,
        size: candidate.size,
        language: languageForPath(candidate.path),
        content
      });
    } catch (error) {
      skipped.push({
        path: candidate.path,
        reason: 'read_error',
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const rootName = basename(rootPath);
  const selectedAt = nowIso();
  const skippedByReason: Partial<Record<WorkspaceSkippedReason, number>> = {};
  for (const entry of skipped) {
    skippedByReason[entry.reason] = (skippedByReason[entry.reason] ?? 0) + 1;
  }
  const coverage: WorkspaceManifestCoverage = {
    totalEntriesSeen,
    scannedEntries: entryCount,
    readableFiles: readableCount,
    generatedSkipped,
    skippedByReason
  };
  return {
    workingDirectory: {
      kind: 'server_local',
      id: crypto.randomUUID(),
      name: rootName,
      path: rootPath,
      selectedAt
    },
    workspaceSnapshot: {
      rootName,
      scannedAt: selectedAt,
      fileCount: entryCount,
      totalBytes,
      tree,
      files,
      skipped,
      detectedStack: detectStack(files),
      entrypoints: detectEntrypoints(files),
      coverage
    }
  };
}

export function extractServerWorkspacePath(input: string) {
  const windowsPath = input.match(/[A-Za-z]:\\[^\s，。；;'"`]+(?:\\[^\s，。；;'"`]+)*/)?.[0];
  if (windowsPath) return windowsPath;
  return input.match(/\/[^\s，。；;'"`]+(?:\/[^\s，。；;'"`]+)*/)?.[0];
}

function extensionOf(path: string) {
  return extname(path).toLowerCase();
}

export function workspaceFileScanPriority(path: string) {
  const normalizedPath = path.replace(/\\/g, '/').toLowerCase();
  const name = normalizedPath.split('/').at(-1) ?? normalizedPath;
  const extension = extensionOf(normalizedPath);

  if (ruleFileNames.has(name)) return 0;
  if (
    /^(?:(?:src\/)?(?:main|index)|apps\/[^/]+\/src\/(?:main|index))\.(?:ts|tsx|js|jsx|mjs|cjs|vue)$/.test(normalizedPath) ||
    name === 'app.vue'
  ) return 10;
  if (configFileNames.has(name) || name.includes('.config.')) return 20;
  if (
    /^(?:src\/)?(?:shared|models?|prompts?|chains?|rag|agents?|memory|tools?)\//.test(normalizedPath) ||
    /\/(?:shared|models?|prompts?|chains?|rag|agents?|memory|tools?)\//.test(normalizedPath) ||
    /(?:^|\/)(?:pipeline|loader|vector-?store|retriever|agent|memory|model|tool)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(normalizedPath)
  ) return 25;
  // Tutorial/demo routers are useful navigation, but must not consume the
  // bounded content window ahead of current data-flow implementations.
  if (/\/(?:demos?|examples?)\/.*\/index\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(normalizedPath)) return 35;
  if (sourceExtensions.has(extension)) return 30;
  if (extension === '.md' || extension === '.txt') return 40;
  return 50;
}

function shouldReadTextFile(path: string) {
  const name = path.split('/').at(-1) ?? path;
  return configFileNames.has(name) || textExtensions.has(extensionOf(path));
}

function languageForPath(path: string) {
  const extension = extensionOf(path);
  return (
    {
      '.css': 'css',
      '.html': 'html',
      '.js': 'javascript',
      '.json': 'json',
      '.jsx': 'javascriptreact',
      '.md': 'markdown',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.vue': 'vue',
      '.yml': 'yaml',
      '.yaml': 'yaml',
      '.txt': 'text'
    }[extension] ?? undefined
  );
}

function detectStack(files: WorkspaceFileSnapshot[]) {
  const paths = new Set(files.map((file) => file.path));
  const packageJson = files.find((file) => file.path.endsWith('package.json'))?.content ?? '';
  return [
    paths.has('package.json') ? 'node' : undefined,
    packageJson.includes('"vue"') ? 'vue' : undefined,
    packageJson.includes('"@nestjs/') ? 'nestjs' : undefined,
    packageJson.includes('"vite"') ? 'vite' : undefined,
    paths.has('tsconfig.json') ? 'typescript' : undefined
  ].filter((item): item is string => Boolean(item));
}

function detectEntrypoints(files: WorkspaceFileSnapshot[]) {
  const likely = [
    'package.json',
    'src/main.ts',
    'src/main.tsx',
    'src/App.vue',
    'apps/web/src/main.ts',
    'apps/server/src/main.ts',
    'README.md',
    'AGENTS.md',
    'CLAUDE.md'
  ];
  const paths = new Set(files.map((file) => file.path));
  return likely.filter((path) => paths.has(path));
}
