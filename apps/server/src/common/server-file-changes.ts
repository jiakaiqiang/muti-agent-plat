import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import type { RuntimeFileChange } from '@agent-cluster/shared';

export async function applyServerLocalFileChanges(rootPath: string, fileChanges: RuntimeFileChange[]) {
  for (const change of fileChanges) {
    const targetPath = safeJoin(rootPath, change.path);
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
