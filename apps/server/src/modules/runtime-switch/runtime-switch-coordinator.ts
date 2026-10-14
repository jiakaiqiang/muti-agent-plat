import { ConflictException } from '@nestjs/common';
import { effectiveRuntimePreference, isRuntimeSwitchTargetAuthorized, resolveFallbackRuntimeChain,
  type RuntimeHandoffCheckpoint, type RuntimeSwitchInput, type RuntimeSwitchRequest, type RuntimeType,
  type SessionDetail } from '@agent-cluster/shared';
import { RuntimeSwitchStore, type RuntimeSwitchRequestRecord } from './runtime-switch-store.js';

export type RuntimeSwitchPorts = {
  session(id: string): SessionDetail;
  generation(id: string): number | undefined;
  preflight(session: SessionDetail, target: RuntimeType): Promise<void>;
  stop(sessionId: string): Promise<void>;
  stopped(sessionId: string): boolean;
  busy(sessionId: string): boolean;
  checkpoint(session: SessionDetail): RuntimeHandoffCheckpoint;
  apply(request: RuntimeSwitchRequestRecord, handoff: RuntimeHandoffCheckpoint): Promise<void>;
  resume(sessionId: string): Promise<void>;
  announce(request: RuntimeSwitchRequestRecord): void;
};

/** One durable transaction path for API and chat; no model owns execution control. */
export class RuntimeSwitchCoordinator {
  private readonly running = new Map<string, Promise<RuntimeSwitchRequestRecord>>();
  constructor(readonly store: RuntimeSwitchStore, private readonly ports: RuntimeSwitchPorts) {}

  async request(sessionId: string, input: RuntimeSwitchInput, source: RuntimeSwitchRequest['source']) {
    const session = this.ports.session(sessionId);
    const preference = effectiveRuntimePreference(session);
    const existing = this.store.list(sessionId).find(item => item.idempotencyKey === input.idempotencyKey);
    const target = input.targetRuntimeType === 'fallback'
      ? existing?.targetRuntimeType ?? resolveFallbackRuntimeChain(preference)[0] : input.targetRuntimeType;
    if (!target) throw new ConflictException('RUNTIME_SWITCH_NO_FALLBACK');
    if (!isRuntimeSwitchTargetAuthorized(preference, target)) throw new ConflictException('RUNTIME_SWITCH_TARGET_NOT_AUTHORIZED');
    if (!existing && input.expectedSessionRevision !== undefined && input.expectedSessionRevision !== (session.revision ?? 0)) {
      throw new ConflictException('RUNTIME_SWITCH_STALE_REVISION');
    }
    if (!existing && (session.archivedAt || ['CANCELLED', 'COMPLETED'].includes(session.status))) throw new ConflictException('RUNTIME_SWITCH_SESSION_TERMINAL');
    const opened = await this.store.open({ sessionId, source, targetRuntimeType: target,
      fromRuntimeType: preference?.preferredRuntimeType,
      resumeAfterSwitch: input.resumeAfterSwitch ?? existing?.resumeAfterSwitch ??
        ['AGENT_DISCUSSING', 'REVISING_BRIEF', 'EXECUTING', 'REWORKING', 'POST_REVIEW'].includes(session.status),
      fallbackMode: input.fallbackMode ?? 'exclude_previous_once', scope: input.scope ?? 'work_item',
      timing: input.timing ?? 'immediate', workItemId: session.activeWorkItemId, requestedBriefId: session.currentTaskBriefId,
      idempotencyKey: input.idempotencyKey, expectedSessionRevision: input.expectedSessionRevision ?? session.revision ?? 0,
      previousSessionStatus: session.status, generation: this.ports.generation(sessionId) });
    if (opened.status === 'rejected') throw new ConflictException(opened.code);
    if (['completed', 'failed'].includes(opened.request.status)) return opened.request;
    return this.advance(opened.request);
  }

  advance(request: RuntimeSwitchRequestRecord): Promise<RuntimeSwitchRequestRecord> {
    const current = this.running.get(request.sessionId);
    if (current) return current;
    const run = this.execute(request).finally(() => this.running.delete(request.sessionId));
    this.running.set(request.sessionId, run);
    return run;
  }

  async recover(sessionId: string) {
    for (const request of this.store.unresolved(sessionId)) {
      if (request.status === 'resuming') {
        await this.move(request, 'failed', { code: 'RUNTIME_SWITCH_RESUME_UNKNOWN',
          message: '服务重启时接续已发起，需核对执行结果后再继续，未重复启动。', retryable: false });
      } else await this.advance(request);
    }
  }

  private async execute(initial: RuntimeSwitchRequestRecord): Promise<RuntimeSwitchRequestRecord> {
    let request = this.store.get(initial.sessionId, initial.id)!;
    try {
      const session = this.ports.session(request.sessionId);
      if (session.archivedAt || session.status === 'CANCELLED') throw new Error('RUNTIME_SWITCH_USER_STOPPED');
      if (request.workItemId !== session.activeWorkItemId || request.requestedBriefId !== session.currentTaskBriefId) throw new Error('RUNTIME_SWITCH_STALE_CONTEXT');
      if (request.status === 'requested' || request.status === 'preflighted') {
        await this.ports.preflight(session, request.targetRuntimeType);
        if (request.status === 'requested') request = await this.move(request, 'preflighted');
        if (request.timing === 'after_step' && this.ports.busy(session.id)) return request;
        request = await this.move(request, 'stopping');
      }
      if (request.status === 'stopping') {
        try { await this.ports.stop(session.id); } catch {
          // Keep the durable stop barrier. A later receipt or explicit retry can finish it.
          request = this.store.get(initial.sessionId, initial.id)!;
          this.ports.announce(request);
          return request;
        }
        if (!this.ports.stopped(session.id)) return request;
        request = await this.move(request, 'stop_confirmed');
      }
      if (request.status === 'stop_confirmed') {
        if (!this.ports.stopped(session.id)) return request;
        await this.ports.preflight(session, request.targetRuntimeType);
        await this.ports.apply(request, this.ports.checkpoint(session));
        request = this.store.get(session.id, request.id)!;
      }
      if (request.status === 'applying') {
        if (request.resumeAfterSwitch) {
          request = await this.move(request, 'resuming');
          await this.ports.resume(session.id);
        }
        request = await this.move(request, 'completed');
      }
      return request;
    } catch (error) {
      request = this.store.get(initial.sessionId, initial.id)!;
      if (['completed', 'failed'].includes(request.status)) return request;
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message : 'RUNTIME_SWITCH_BLOCKED';
      return this.move(request, 'failed', { code,
        message: 'Runtime 切换未完成。已保留任务与改动，请检查目标能力、停止状态或接续证据。', retryable: false });
    }
  }

  private async move(request: RuntimeSwitchRequestRecord, status: RuntimeSwitchRequest['status'], error?: RuntimeSwitchRequest['error']) {
    const result = await this.store.transition(request.id, status, { generation: request.generation, error });
    if (result.status === 'rejected') throw new Error(result.code);
    this.ports.announce(result.request);
    return result.request;
  }
}
