import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { ConflictFileView, ConflictView } from '../contracts.js';
import { isSensitiveWorkspacePath } from '../workspace-path-safety.js';
import { AuthorizedGit } from './authorized-git.js';
import { GitRepositoryWorkspaceManager } from './repository-workspace-manager.js';

type Stage = { mode: string; sha: string };
type ConflictStart = { view?: ConflictView; treeSha?: string };
const sha = /^[a-f0-9]{40}$/i;

export class GitConflictEditor {
  private readonly git = new AuthorizedGit();
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private readonly manager: GitRepositoryWorkspaceManager) {}

  async start(input: {
    sessionId: string; round: number; headSha: string; baseBranch: string;
    token: string; targetOperation: 'merge_pull_request' | 'integrate_task_branch'
  }): Promise<ConflictStart> {
    if (!sha.test(input.headSha) || !input.baseBranch || input.baseBranch.length > 200) {
      throw new Error('GITHUB_CONFLICT_INPUT_INVALID');
    }
    const remoteRef = `refs/remotes/origin/${input.baseBranch}`;
    const sessionPath = this.manager.sessionWorkspacePath(input.sessionId);
    await this.git.run(sessionPath,
      ['check-ref-format', remoteRef]);
    const remoteLine = await this.git.run(sessionPath,
      ['ls-remote', '--heads', 'origin', `refs/heads/${input.baseBranch}`], input.token);
    const remoteHeadSha = remoteLine.split(/\s+/)[0];
    if (!sha.test(remoteHeadSha)) throw new Error('GITHUB_CONFLICT_TARGET_MISSING');
    const previous = await this.load(input.sessionId).catch(() => undefined);
    if (previous && previous.deliveryRound === input.round &&
        previous.targetOperation === input.targetOperation &&
        previous.sourceHeadSha === input.headSha &&
        previous.targetBranch === input.baseBranch &&
        previous.targetHeadSha === remoteHeadSha) return { view: previous };
    const path = await this.manager.prepareDeliveryAtCommit(input.sessionId, input.headSha);
    await this.git.run(path, ['fetch', 'origin',
      `+refs/heads/${input.baseBranch}:${remoteRef}`], input.token);
    const baseSha = await this.git.run(path, ['rev-parse', '--verify', `${remoteRef}^{commit}`]);
    try {
      await this.git.run(path, ['-c', 'user.name=Agent Cluster',
        '-c', 'user.email=agent-cluster@local.invalid',
        'merge', '--no-commit', '--no-ff', baseSha]);
      return { treeSha: await this.git.run(path, ['write-tree']) };
    } catch (error) {
      const entries = await this.unmerged(path);
      if (!entries.size) throw error;
      return { view: await this.captureExisting(input.sessionId, input.round,
        input.targetOperation, input.headSha, input.baseBranch, baseSha) };
    }
  }

  async captureExisting(sessionId: string, round: number,
    targetOperation: 'merge_pull_request' | 'integrate_task_branch',
    sourceHeadSha?: string, targetBranch?: string, targetHeadSha?: string): Promise<ConflictView> {
    const path = this.manager.deliveryWorkspacePath(sessionId);
    const entries = await this.unmerged(path);
    if (!entries.size) throw new Error('GITHUB_CONFLICT_INDEX_EMPTY');
    const renamedPaths = await this.renamedPaths(path);
    const files: ConflictFileView[] = [];
    for (const [filePath, stages] of entries) {
      if (isSensitiveWorkspacePath(filePath) || filePath.startsWith('/') ||
          filePath.split('/').includes('..')) throw new Error('GITHUB_CONFLICT_PATH_DENIED');
      const ours = stages.get(2);
      const theirs = stages.get(3);
      const base = stages.get(1);
      const oursData = await this.stageContent(path, ours);
      const theirsData = await this.stageContent(path, theirs);
      const modeConflict = Boolean([base, ours, theirs].some((stage) =>
        stage?.mode === '120000' || stage?.mode === '160000') ||
        ours && theirs && ours.mode !== theirs.mode);
      const deleted = !ours || !theirs;
      const binary = [oursData, theirsData].some((data) => data?.binary);
      const kind = renamedPaths.has(filePath) ? 'renamed'
        : deleted ? 'deleted' : modeConflict ? 'mode' : binary ? 'binary' : 'text';
      const resultBytes = kind === 'text' ? await readFile(join(path, filePath)).catch(() => undefined) : undefined;
      files.push({ fileId: createHash('sha256').update(filePath).digest('hex').slice(0, 32),
        path: filePath, kind, status: 'unresolved', version: 1,
        ...(renamedPaths.has(filePath) ? { previousPath: renamedPaths.get(filePath) } : {}),
        baseObjectId: base?.sha, oursObjectId: ours?.sha, theirsObjectId: theirs?.sha,
        ...(kind === 'text' ? { oursContent: oursData?.text ?? '',
          theirsContent: theirsData?.text ?? '',
          resultContent: textContent(resultBytes) ?? '' } : {}) });
    }
    const now = new Date().toISOString();
    const view: ConflictView = { id: randomUUID(), sessionId,
      deliveryRound: round, source: 'git', targetOperation,
      ...(sourceHeadSha ? { sourceHeadSha } : {}),
      ...(targetBranch ? { targetBranch } : {}),
      ...(targetHeadSha ? { targetHeadSha } : {}),
      version: 1, files: files.sort((a, b) => a.path.localeCompare(b.path)),
      createdAt: now, updatedAt: now };
    await this.saveState(view);
    return view;
  }

  async view(sessionId: string, conflictId: string): Promise<ConflictView> {
    const view = await this.load(sessionId);
    if (view.id !== conflictId) throw new Error('GITHUB_CONFLICT_NOT_FOUND');
    return view;
  }

  async saveFile(input: { sessionId: string; conflictId: string; fileId: string;
    expectedVersion: number; resultContent?: string; binaryChoice?: 'ours' | 'theirs';
    confirm: boolean }): Promise<ConflictView> {
    return this.serialize(input.sessionId, () => this.saveFileUnlocked(input));
  }

  private async saveFileUnlocked(input: { sessionId: string; conflictId: string; fileId: string;
    expectedVersion: number; resultContent?: string; binaryChoice?: 'ours' | 'theirs';
    confirm: boolean }): Promise<ConflictView> {
    const view = await this.view(input.sessionId, input.conflictId);
    if (view.version !== input.expectedVersion) throw new Error('GITHUB_CONFLICT_VERSION_CONFLICT');
    const file = view.files.find((item) => item.fileId === input.fileId);
    if (!file) throw new Error('GITHUB_CONFLICT_FILE_NOT_FOUND');
    if (file.kind === 'text') {
      if (typeof input.resultContent !== 'string' ||
          Buffer.byteLength(input.resultContent) > 1_000_000) {
        throw new Error('GITHUB_CONFLICT_RESULT_INVALID');
      }
      if (input.confirm && /^(<{7}|={7}|>{7})/m.test(input.resultContent)) {
        throw new Error('GITHUB_CONFLICT_MARKERS_REMAIN');
      }
    } else if (input.binaryChoice !== 'ours' && input.binaryChoice !== 'theirs') {
      throw new Error('GITHUB_CONFLICT_CHOICE_REQUIRED');
    }
    if (input.confirm) {
      const path = this.manager.deliveryWorkspacePath(input.sessionId);
      if (file.kind === 'text') {
        const target = join(path, file.path);
        const info = await lstat(target).catch(() => undefined);
        if (info?.isSymbolicLink()) throw new Error('GITHUB_CONFLICT_SYMLINK_DENIED');
        const root = await realpath(path);
        const parts = relative(root, dirname(target)).split(/[\\/]/).filter(Boolean);
        let ancestor = root;
        for (const part of parts) {
          ancestor = join(ancestor, part);
          const entry = await lstat(ancestor).catch(() => undefined);
          if (entry?.isSymbolicLink()) throw new Error('GITHUB_CONFLICT_SYMLINK_DENIED');
        }
        await mkdir(dirname(target), { recursive: true });
        const parent = await realpath(dirname(target));
        const inside = relative(root, parent);
        if (inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
            isAbsolute(inside)) throw new Error('GITHUB_CONFLICT_PATH_DENIED');
        await writeFile(target, input.resultContent!, 'utf8');
        await this.git.run(path, ['add', '--', file.path]);
      } else {
        const stageExists = input.binaryChoice === 'ours'
          ? Boolean(file.oursObjectId) : Boolean(file.theirsObjectId);
        if (stageExists) {
          await this.git.run(path, ['checkout', `--${input.binaryChoice}`, '--', file.path]);
          await this.git.run(path, ['add', '--', file.path]);
        } else {
          await this.git.run(path, ['rm', '-f', '--', file.path]);
        }
      }
    }
    const updated: ConflictView = { ...view, version: view.version + 1,
      updatedAt: new Date().toISOString(),
      files: view.files.map((item) => item.fileId === input.fileId
        ? { ...item, version: item.version + 1,
          status: input.confirm ? 'confirmed' : 'draft',
          ...(file.kind === 'text' ? { resultContent: input.resultContent } :
            { binaryChoice: input.binaryChoice }) }
        : item) };
    await this.saveState(updated);
    return updated;
  }

  async complete(sessionId: string, conflictId: string, expectedVersion: number): Promise<string> {
    return this.serialize(sessionId, () => this.completeUnlocked(sessionId, conflictId, expectedVersion));
  }

  private async completeUnlocked(sessionId: string, conflictId: string, expectedVersion: number): Promise<string> {
    const view = await this.view(sessionId, conflictId);
    if (view.version !== expectedVersion) throw new Error('GITHUB_CONFLICT_VERSION_CONFLICT');
    if (view.files.some((file) => file.status !== 'confirmed')) {
      throw new Error('GITHUB_CONFLICT_INCOMPLETE');
    }
    const path = this.manager.deliveryWorkspacePath(sessionId);
    if ((await this.unmerged(path)).size) throw new Error('GITHUB_CONFLICT_UNMERGED');
    return this.git.run(path, ['write-tree']);
  }

  private serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(sessionId);
    const current = (previous ?? Promise.resolve()).then(operation, operation);
    this.pending.set(sessionId, current);
    void current.finally(() => {
      if (this.pending.get(sessionId) === current) this.pending.delete(sessionId);
    }).catch(() => undefined);
    return current;
  }

  private async unmerged(path: string): Promise<Map<string, Map<number, Stage>>> {
    const output = await this.git.run(path, ['ls-files', '--unmerged', '-z'], undefined, { raw: true });
    const entries = new Map<string, Map<number, Stage>>();
    for (const raw of output.split('\0').filter(Boolean)) {
      const match = /^([0-7]{6}) ([a-f0-9]{40}) ([123])\t([\s\S]+)$/.exec(raw);
      if (!match) throw new Error('GITHUB_CONFLICT_INDEX_INVALID');
      const pathStages = entries.get(match[4]) ?? new Map<number, Stage>();
      pathStages.set(Number(match[3]), { mode: match[1], sha: match[2] });
      entries.set(match[4], pathStages);
    }
    return entries;
  }

  private async renamedPaths(path: string): Promise<Map<string, string>> {
    const mergeHead = await this.git.run(path,
      ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => undefined);
    const cherryHead = mergeHead ? undefined : await this.git.run(path,
      ['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD']).catch(() => undefined);
    if (!mergeHead && !cherryHead) return new Map();
    const base = mergeHead
      ? await this.git.run(path, ['merge-base', 'HEAD', mergeHead])
      : await this.git.run(path, ['rev-parse', `${cherryHead}^`]);
    const renamed = new Map<string, string>();
    for (const head of ['HEAD', mergeHead ?? cherryHead!]) {
      const output = await this.git.run(path,
        ['diff', '--name-status', '-M', '-z', base, head, '--'],
        undefined, { raw: true });
      const parts = output.split('\0').filter(Boolean);
      for (let index = 0; index < parts.length;) {
        const status = parts[index++];
        if (!status) break;
        const previous = parts[index++];
        if (!previous) throw new Error('GITHUB_RENAME_STATUS_INVALID');
        if (status.startsWith('R')) {
          const next = parts[index++];
          if (!next) throw new Error('GITHUB_RENAME_STATUS_INVALID');
          renamed.set(previous, previous);
          renamed.set(next, previous);
        }
      }
    }
    return renamed;
  }

  private async stageContent(path: string, stage: Stage | undefined): Promise<{
    text?: string; binary: boolean
  } | undefined> {
    if (!stage) return undefined;
    if (!/^100[0-7]{3}$/.test(stage.mode) && stage.mode !== '120000') {
      return { binary: true };
    }
    const size = Number(await this.git.run(path, ['cat-file', '-s', stage.sha]));
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('GITHUB_CONFLICT_OBJECT_INVALID');
    if (size > 250_000) return { binary: true };
    const text = textContent(await this.git.runBytes(path, ['cat-file', 'blob', stage.sha]));
    return text === undefined ? { binary: true } : { text, binary: false };
  }

  private async load(sessionId: string): Promise<ConflictView> {
    const value = JSON.parse(await readFile(this.manager.conflictStatePath(sessionId), 'utf8')) as ConflictView;
    if (value.sessionId !== sessionId || !Array.isArray(value.files)) {
      throw new Error('GITHUB_CONFLICT_STATE_INVALID');
    }
    return value;
  }

  private async saveState(view: ConflictView): Promise<void> {
    const target = this.manager.conflictStatePath(view.sessionId);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(view), { flag: 'wx' });
    await rename(temporary, target);
  }
}

function textContent(bytes: Buffer | undefined): string | undefined {
  if (!bytes || bytes.length > 250_000 || bytes.includes(0)) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return undefined; }
}
