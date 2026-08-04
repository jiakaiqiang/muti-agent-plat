import { rename } from 'node:fs/promises';

type RenameFile = (from: string, to: string) => Promise<void>;
type Sleep = (milliseconds: number) => Promise<void>;

export async function renameWithRetry(
  temporary: string,
  destination: string,
  options: {
    renameFile?: RenameFile;
    sleep?: Sleep;
    maxAttempts?: number;
  } = {}
): Promise<void> {
  const renameFile = options.renameFile ?? rename;
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const maxAttempts = options.maxAttempts ?? 8;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await renameFile(temporary, destination);
      return;
    } catch (error) {
      if (!isTransientWindowsFileLock(error) || attempt === maxAttempts - 1) throw error;
      await sleep(25 * 2 ** attempt);
    }
  }
}

function isTransientWindowsFileLock(error: unknown) {
  if (process.platform !== 'win32') return false;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}
