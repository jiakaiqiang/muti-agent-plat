import type { RuntimeHealthIdentity, RuntimeHealthSnapshot, RuntimeObservation } from '@agent-cluster/shared';
import { RUNTIME_HEALTH_POLICY_VERSION, unknownRuntimeHealthCapabilities } from '@agent-cluster/shared';

export type RuntimeHealthState = {
  snapshot: RuntimeHealthSnapshot; startedMono: number; lastProgressMono: number; lastSequence: number; seen: string[];
};
type Seed = RuntimeHealthIdentity & Pick<RuntimeHealthSnapshot, 'phase' | 'agentId' | 'runtimeType' | 'startedAt'> &
  Partial<Pick<RuntimeHealthSnapshot, 'deadlineAt' | 'capabilities' | 'version'>>;
export function createRuntimeHealthState(seed: Seed, now: number): RuntimeHealthState {
  return { startedMono: now, lastProgressMono: now, lastSequence: -1, seen: [], snapshot: {
    ...seed, schemaVersion: 1, policyVersion: RUNTIME_HEALTH_POLICY_VERSION, version: seed.version ?? 1,
    capabilities: seed.capabilities ?? unknownRuntimeHealthCapabilities(), stage: 'awaiting_response', health: 'unknown',
    reasonCode: 'request_pending', processStatus: 'unknown', requestStatus: 'unknown',
    updatedAt: seed.startedAt, observationDue: false, canWait: false, canStop: true
  } };
}
type Input = { type: 'observation'; observation: RuntimeObservation } | { type: 'tick'; observedAt: string } | { type: 'wait'; observedAt: string };
const progress = new Set(['text_progress', 'reasoning_progress', 'tool_input_progress', 'tool_started', 'tool_progress', 'tool_completed', 'submission_accepted']);

/** Pure, receiver-monotonic policy. It emits state, never an implicit cancellation action. */
export function reduceRuntimeHealth(state: RuntimeHealthState, input: Input, now: number, silenceMs: number): RuntimeHealthState {
  const current = state.snapshot;
  if (current.stage === 'terminal') return state;
  const snapshot = { ...current, capabilities: { ...current.capabilities } };
  let next = { ...state, snapshot };
  if (input.type === 'tick') {
    if (current.stage === 'stopping' || current.health === 'abnormal' || now - state.lastProgressMono < silenceMs) return state;
    if (current.stage === 'unknown_wait') return state;
    Object.assign(snapshot, { stage: 'unknown_wait', health: 'unknown', reasonCode: 'no_observable_progress',
      unknownSince: current.unknownSince ?? input.observedAt, observationDue: true, canWait: true });
  } else if (input.type === 'wait') {
    if (!current.canWait || current.stage !== 'unknown_wait') return state;
    snapshot.lastWaitAcknowledgedAt = input.observedAt;
  } else {
    const o = input.observation;
    if (o.sessionId !== current.sessionId || o.operationId !== current.operationId || o.invocationId !== current.invocationId ||
      o.sessionGeneration !== current.sessionGeneration || o.observerEpoch !== current.observerEpoch ||
      !Number.isSafeInteger(o.sequence) || o.sequence <= state.lastSequence) return state;
    next.lastSequence = o.sequence;
    const key = o.eventId ? `${o.source}:${o.eventId}` : undefined;
    if (key && state.seen.includes(key)) return { ...state, lastSequence: o.sequence };
    if (key) next.seen = [...state.seen.slice(-4095), key];
    if (current.stage === 'stopping' && !['terminal_received', 'stop_unconfirmed', 'process_exited'].includes(o.kind)) return next;
    const irreversibleFailure = current.reasonCode === 'control_disconnected' || current.failure?.code === 'process_exited';
    if (o.processStatus && current.failure?.code !== 'process_exited') snapshot.processStatus = o.processStatus;
    if (o.requestStatus) snapshot.requestStatus = o.requestStatus;
    if (progress.has(o.kind)) {
      snapshot.capabilities.progressEvents = 'supported';
      if (o.kind === 'reasoning_progress') snapshot.capabilities.reasoningEvents = 'supported';
      if (o.count !== undefined && (!Number.isFinite(o.count) || o.count <= 0)) return { ...state, lastSequence: o.sequence };
      next.lastProgressMono = now;
      snapshot.lastProgressAt = o.observedAt;
      // A late result from an already-running tool does not prove the failed provider recovered.
      const preservesFailure = current.health === 'abnormal' && (irreversibleFailure ||
        current.reasonCode === 'output_contract_error' && o.kind !== 'submission_accepted' ||
        ['provider_retry', 'provider_error'].includes(current.reasonCode) && ['tool_progress', 'tool_completed'].includes(o.kind));
      if (preservesFailure) {
        snapshot.version = current.version + 1; snapshot.updatedAt = o.observedAt;
        return next;
      }
      delete snapshot.failure; delete snapshot.failureAt;
      Object.assign(snapshot, { health: 'progressing', reasonCode: o.kind, observationDue: false, canWait: false, unknownSince: undefined });
      snapshot.stage = o.kind === 'reasoning_progress' ? 'reasoning' : o.kind === 'text_progress' ? 'responding'
        : ['tool_completed', 'submission_accepted'].includes(o.kind) ? 'awaiting_response' : 'tool_running';
      if (['reasoning_progress', 'text_progress', 'tool_input_progress'].includes(o.kind)) snapshot.requestStatus = 'receiving';
    } else if (o.kind === 'transport_alive') snapshot.lastTransportAt = o.observedAt;
    else if (o.kind === 'request_started' || o.kind === 'request_acknowledged') {
      snapshot.capabilities.requestLifecycle = 'supported';
      snapshot.requestStatus = 'pending';
      if (current.stage !== 'unknown_wait' && current.health !== 'abnormal') snapshot.stage = 'awaiting_response';
    } else if (o.kind === 'probe_result') {
      snapshot.capabilities.processProbe = o.probeStatus === 'unsupported' ? 'unsupported' : 'supported';
      snapshot.lastProbeAt = o.observedAt;
      if (o.probeStatus === 'ok' && o.processStatus === 'exited') Object.assign(snapshot, {
        stage: 'retrying', health: 'abnormal', reasonCode: 'provider_error', canWait: false,
        failure: { code: 'process_exited' }, failureAt: o.observedAt });
      else if (o.probeStatus !== 'ok' && current.health !== 'abnormal') Object.assign(snapshot, { stage: 'unknown_wait', health: 'unknown',
        reasonCode: o.probeStatus === 'timeout' ? 'probe_timeout' : 'probe_unsupported', canWait: true,
        unknownSince: current.unknownSince ?? o.observedAt, observationDue: true });
    } else if (['provider_retry', 'provider_error', 'tool_error', 'output_contract_error', 'control_disconnected'].includes(o.kind)) {
      // Neither a late tool failure nor unrelated diagnostics can erase a stronger unresolved fault.
      if (current.health === 'abnormal' && (irreversibleFailure ||
        ['provider_retry', 'provider_error'].includes(current.reasonCode) && o.kind === 'tool_error')) {
        snapshot.version = current.version + 1; snapshot.updatedAt = o.observedAt;
        return next;
      }
      Object.assign(snapshot, { stage: 'retrying', health: 'abnormal', reasonCode: o.kind, canWait: false });
      snapshot.failure = o.failure;
      snapshot.failureAt = o.observedAt;
    } else if (o.kind === 'stop_requested' || o.kind === 'stop_unconfirmed') {
      Object.assign(snapshot, { stage: 'stopping', health: o.kind === 'stop_unconfirmed' ? 'abnormal' : 'unknown',
        reasonCode: o.kind, canWait: false, canStop: false });
    } else if (o.kind === 'terminal_received' || o.kind === 'process_exited') {
      Object.assign(snapshot, { stage: 'terminal', health: 'terminal', reasonCode: o.kind,
        processStatus: 'exited', requestStatus: 'ended', canWait: false, canStop: false });
    }
  }
  snapshot.version = current.version + 1;
  snapshot.updatedAt = input.type === 'observation' ? input.observation.observedAt : input.observedAt;
  return next;
}
