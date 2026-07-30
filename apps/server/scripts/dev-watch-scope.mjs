import { watch } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export function devWatchRoots(serverRoot, workspaceRoot) {
  return [resolve(serverRoot, 'src'), resolve(workspaceRoot, 'packages', 'shared', 'src')];
}

export function isDevWatchedPath(filePath, roots) {
  const target = resolve(filePath);
  return roots.some((root) => {
    const candidate = relative(resolve(root), target);
    return candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate));
  });
}

export function startDevWatchTriggerLogger(options) {
  const roots = options.roots.map((root) => resolve(root));
  const watchDirectory = options.watchDirectory ?? watch;
  const writeLog = options.writeLog ?? ((entry) => console.log(`[dev-server-watch] ${JSON.stringify(entry)}`));
  const startedAt = options.startedAt ?? new Date().toISOString();
  const pid = options.pid ?? process.pid;
  const watchers = roots.map((root) => watchDirectory(root, { recursive: true }, (eventType, fileName) => {
    if (!fileName) return;
    const triggerPath = resolve(root, String(fileName));
    if (!isDevWatchedPath(triggerPath, roots)) return;
    writeLog({ eventType, triggerPath, watcherPid: pid, watcherStartedAt: startedAt });
  }));
  return {
    close() {
      for (const watcher of watchers) watcher.close();
    }
  };
}
