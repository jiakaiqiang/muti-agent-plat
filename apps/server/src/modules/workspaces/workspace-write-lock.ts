export class WorkspaceWriteLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(path: string, task: () => Promise<T>): Promise<T> {
    return await this.runAll([path], task);
  }

  async runAll<T>(paths: readonly string[], task: () => Promise<T>): Promise<T> {
    const unique = Array.from(new Set(paths)).sort();
    const previous = unique.map((path) => this.tails.get(path)).filter((entry): entry is Promise<unknown> => Boolean(entry));
    let resolveRelease: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });
    for (const path of unique) {
      this.tails.set(path, release);
    }
    try {
      if (previous.length > 0) {
        await Promise.allSettled(previous);
      }
      return await task();
    } finally {
      resolveRelease();
      queueMicrotask(() => {
        for (const path of unique) {
          if (this.tails.get(path) === release) {
            this.tails.delete(path);
          }
        }
      });
    }
  }
}

export const globalWorkspaceWriteLock = new WorkspaceWriteLock();
