import { rm, rmSync, type RmOptions } from 'node:fs';
import { promisify } from 'node:util';

const rmAsync = promisify(rm);

export const runtimeDirectoryCleanupOptions: RmOptions = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 150
};

export async function removeRuntimeDirectory(targetPath: string): Promise<void> {
  await rmAsync(targetPath, runtimeDirectoryCleanupOptions);
}

export function removeRuntimeDirectorySync(targetPath: string): void {
  rmSync(targetPath, runtimeDirectoryCleanupOptions);
}
