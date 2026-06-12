import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import type { RuntimeFileChange } from '@agent-cluster/shared';

export async function applyServerLocalFileChanges(rootPath: string, fileChanges: RuntimeFileChange[]) {
  for (const change of fileChanges) {
    const targetPath = safeJoin(rootPath, change.path);
    await assertNoUnexpectedOverwrite(targetPath, change);
    if (change.operation === 'delete') {
      await rm(targetPath, { force: true });
      continue;
    }
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, change.content ?? '', change.encoding ?? 'utf-8');
  }
}

function safeJoin(rootPath: string, relativePath: string) {
  const normalizedRoot = resolve(rootPath);
  const normalizedTarget = resolve(join(normalizedRoot, normalize(relativePath)));
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`文件变更路径必须位于工作目录内：${relativePath}`);
  }
  return normalizedTarget;
}

async function assertNoUnexpectedOverwrite(targetPath: string, change: RuntimeFileChange) {
  if (!Object.prototype.hasOwnProperty.call(change, 'previousContent')) {
    return;
  }

  const current = await readCurrentText(targetPath);
  const previous = change.previousContent ?? null;

  if (change.operation === 'create') {
    if (current === null || current === change.content) {
      return;
    }
    throw new Error(`文件已存在且内容不同，拒绝覆盖：${change.path}`);
  }

  if (change.operation === 'update') {
    if (current === previous || current === change.content) {
      return;
    }
    throw new Error(`文件内容已变化，拒绝覆盖：${change.path}`);
  }

  if (change.operation === 'delete') {
    if (current === null || current === previous) {
      return;
    }
    throw new Error(`文件内容已变化，拒绝删除：${change.path}`);
  }
}

async function readCurrentText(path: string) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
