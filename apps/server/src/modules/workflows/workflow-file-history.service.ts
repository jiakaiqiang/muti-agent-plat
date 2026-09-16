import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Artifact, AgentTask, SessionDetail, WorkflowRun, WorkflowFileBaseline, WorkflowDeliveryFileDiff } from '@agent-cluster/shared';
import { WorkspaceProviderResolver } from '../workspaces/workspace-provider-resolver.js';
import { ArtifactsService } from '../artifacts/artifacts.service.js';
import { TasksService } from '../tasks/tasks.service.js';

const hash = (content: string) => createHash('sha256').update(content).digest('hex');

async function withinDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('文件基线采集超时。')), Math.max(1, deadline - Date.now()));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

@Injectable()
export class WorkflowFileHistoryService {
  constructor(private readonly providers: WorkspaceProviderResolver, private readonly artifacts: ArtifactsService, private readonly tasks: TasksService) {}

  async captureBaseline(session: SessionDetail): Promise<WorkflowFileBaseline> {
    const baseline: WorkflowFileBaseline = { capturedAt: new Date().toISOString(), complete: false, hashes: {} };
    const provider = this.providers.resolve(session);
    if (!provider) return { ...baseline, reason: '工作区不可用，未捕获运行开始基线。' };
    // Bound scanning; an incomplete manifest must never claim a file was absent.
    const directories = [''];
    let count = 0; let bytes = 0;
    const deadline = Date.now() + 15_000;
    try {
      while (directories.length) {
        if (Date.now() > deadline || ++count > 512) throw new Error('基线采集超出 15 秒或 512 个目录上限。');
        const page = await withinDeadline(provider.listDirectory({ path: directories.shift()!, recursive: false, limit: 1024, deadlineMs: 3000 }), deadline);
        if (page.nextCursor) throw new Error('目录条目超出基线采集上限。');
        for (const entry of page.entries) {
          if (entry.kind === 'directory') { directories.push(entry.path); continue; }
          if (Object.keys(baseline.hashes).length >= 1024 || entry.size > 2 * 1024 * 1024 || (bytes += entry.size) > 32 * 1024 * 1024) throw new Error('工作区超出基线采集大小上限。');
          if (Date.now() > deadline) throw new Error('基线采集超时。');
          const stat = await withinDeadline(provider.statFile({ path: entry.path }), deadline);
          if (!stat.hash) throw new Error('工作区未提供完整文件哈希。');
          baseline.hashes[entry.path] = stat.hash.value;
        }
      }
      baseline.complete = true;
    } catch (error) { baseline.reason = error instanceof Error ? error.message : '基线采集失败。'; }
    return baseline;
  }

  delivery(run: WorkflowRun) {
    return buildDeliveryFileDiff(run, this.tasks.list(run.sessionId), this.artifacts.listBySession(run.sessionId));
  }
}

/** Composes version contents only after proving every observed transition against the start manifest. */
export function buildDeliveryFileDiff(run: WorkflowRun, tasks: AgentTask[], artifacts: Artifact[]): WorkflowDeliveryFileDiff {
  const source = `${run.id} · 运行开始 → 最终交付`;
  const unavailable = (reason: string): WorkflowDeliveryFileDiff => ({ status: 'unavailable', source, reason, files: [] });
  if (run.status !== 'completed' || !run.completedAt) return unavailable('工作流尚未最终交付。');
  if (!run.fileBaseline?.complete) return unavailable(run.fileBaseline?.reason ?? '历史运行没有完整开始基线。');
  const runTasks = tasks.filter(task => task.workflowRunId === run.id && task.sessionId === run.sessionId);
  const taskIds = new Set(runTasks.map(task => task.id));
  const evidence = artifacts.filter(item => item.sessionId === run.sessionId && item.taskId && taskIds.has(item.taskId) && item.createdAt <= run.completedAt!);
  // Even a no-change invocation must carry an empty, authoritative ChangeSet.
  if (runTasks.some(task => !evidence.some(item => item.taskId === task.id && item.systemEvidence?.workspaceChangeSet))) return unavailable('部分执行轮次未保存完整文件证据，无法证明累计差异。');
  const files = new Map<string, WorkflowDeliveryFileDiff['files'][number]>();
  const current = new Map(Object.entries(run.fileBaseline.hashes));
  const seen = new Set<string>();
  const ordered = [...evidence].sort((a, b) => (a.systemEvidence?.capturedAt ?? a.createdAt).localeCompare(b.systemEvidence?.capturedAt ?? b.createdAt));
  for (const artifact of ordered) {
    const changeset = artifact.systemEvidence?.workspaceChangeSet;
    if (!changeset || seen.has(changeset.id)) continue;
    seen.add(changeset.id);
    for (const change of changeset.changes) {
      if (change.operation === 'move') return unavailable('重命名证据缺少完整两端内容，无法证明累计差异。');
      const before = change.operation === 'create' ? '' : change.baseContent;
      const after = change.operation === 'delete' ? '' : change.content;
      if (before === undefined) return unavailable(`缺少历史原文：${change.path}`);
      if (change.operation === 'create' ? current.has(change.path) : current.get(change.path) !== change.expectedHash.value || hash(before) !== change.expectedHash.value) return unavailable(`文件版本链不连续：${change.path}`);
      const existing = files.get(change.path);
      const original = existing?.before ?? before;
      const existedAtStart = Object.prototype.hasOwnProperty.call(run.fileBaseline.hashes, change.path);
      if (change.operation === 'delete') current.delete(change.path); else current.set(change.path, hash(after));
      const existsAfter = current.has(change.path);
      if (original === after && existedAtStart === existsAfter) files.delete(change.path);
      else files.set(change.path, { path: change.path, before: original, after, operation: !existsAfter ? 'delete' : existedAtStart ? 'update' : 'create' });
    }
  }
  return { status: 'complete', source, files: [...files.values()].sort((a,b) => a.path.localeCompare(b.path)) };
}
