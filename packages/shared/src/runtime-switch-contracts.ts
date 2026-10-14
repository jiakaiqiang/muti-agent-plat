import {
  isRuntimeType,
  type ISODateTime,
  type RuntimePreference,
  type SessionDetail,
  type RuntimeType,
  type UUID
} from './contracts.js';

/**
 * Session Runtime switch contracts.
 *
 * `allowedRuntimeTypes` is an unordered authorization set; `fallbackRuntimeTypes`
 * is the ordered degradation chain. Keeping them apart is what stops a reorder
 * from widening permission: normalization can drop a fallback entry that is not
 * authorized, but it can never add one (Spec I5).
 */
export const RUNTIME_SWITCH_CONTRACT_VERSION = 'runtime-switch-v1' as const;

/**
 * What happens to the previous Runtime once the target takes over.
 *
 * `exclude_previous_once` is the default: the user asked for a different Runtime,
 * so falling straight back to the one they just left would silently undo the
 * request, but permanently dropping its authorization is not what they asked for
 * either. The exclusion therefore lives on one attempt group, not on the policy.
 */
export type RuntimeSwitchFallbackMode = 'keep' | 'exclude_previous_once' | 'target_only';

export const RUNTIME_SWITCH_FALLBACK_MODES = [
  'keep',
  'exclude_previous_once',
  'target_only'
] as const satisfies readonly RuntimeSwitchFallbackMode[];

export const DEFAULT_RUNTIME_SWITCH_FALLBACK_MODE: RuntimeSwitchFallbackMode = 'exclude_previous_once';

export function isRuntimeSwitchFallbackMode(value: unknown): value is RuntimeSwitchFallbackMode {
  return typeof value === 'string' && (RUNTIME_SWITCH_FALLBACK_MODES as readonly string[]).includes(value);
}

/**
 * Normalizes a RuntimePreference into a form the routing layer can trust.
 *
 * Invariants it establishes, so no caller has to re-check them:
 * - every Runtime type is a real one; unknown values are dropped, not defaulted;
 * - `fallbackRuntimeTypes` is deduplicated, ordered, authorized, and never
 *   repeats the preferred Runtime;
 * - an unauthorized preferred Runtime is dropped rather than quietly added to
 *   the allowed set, because the allowed set is the permission boundary;
 * - `revision` only survives as a non-negative integer.
 */
export function normalizeRuntimePreference(input?: RuntimePreference): RuntimePreference | undefined {
  if (!input) return undefined;

  const allowedRuntimeTypes = Array.from(new Set((input.allowedRuntimeTypes ?? []).filter(isRuntimeType)));
  const allowed = new Set(allowedRuntimeTypes);
  const candidatePreferred = isRuntimeType(input.preferredRuntimeType) ? input.preferredRuntimeType : undefined;
  // An allowlist is a boundary, not a suggestion: a preferred Runtime outside it
  // is dropped. Honouring it instead would let a preference widen permission.
  const preferredRuntimeType =
    candidatePreferred && (input.allowedRuntimeTypes === undefined || allowed.has(candidatePreferred)) ? candidatePreferred : undefined;
  const preferredModelId = input.preferredModelId?.trim() || undefined;

  const fallbackRuntimeTypes = Array.from(new Set((input.fallbackRuntimeTypes ?? []).filter(isRuntimeType)))
    .filter((runtimeType) => runtimeType !== preferredRuntimeType)
    .filter((runtimeType) => input.allowedRuntimeTypes === undefined || allowed.has(runtimeType));

  const revision =
    typeof input.revision === 'number' && Number.isInteger(input.revision) && input.revision >= 0
      ? input.revision
      : undefined;

  const preference: RuntimePreference = {
    ...(preferredRuntimeType ? { preferredRuntimeType } : {}),
    ...(preferredModelId ? { preferredModelId } : {}),
    ...(input.allowedRuntimeTypes !== undefined ? { allowedRuntimeTypes } : {}),
    ...(input.fallbackRuntimeTypes !== undefined ? { fallbackRuntimeTypes } : {}),
    ...(revision !== undefined ? { revision } : {})
  };
  return Object.keys(preference).length ? preference : undefined;
}

/**
 * The ordered fallback chain for a Session.
 *
 * Sessions created before `fallbackRuntimeTypes` existed still have to degrade
 * somewhere, so the chain is derived from the authorization set minus the
 * preferred Runtime. That derivation is a read-time default only: it never
 * widens `allowedRuntimeTypes`, and an explicit empty chain stays empty because
 * "no fallback" is a real choice (`target_only`).
 */
export function resolveFallbackRuntimeChain(preference?: RuntimePreference): RuntimeType[] {
  if (!preference) return [];
  const normalized = normalizeRuntimePreference(preference);
  if (!normalized) return [];
  if (normalized.fallbackRuntimeTypes) return [...normalized.fallbackRuntimeTypes];
  if (preference.fallbackRuntimeTypes) return [];
  return (normalized.allowedRuntimeTypes ?? []).filter(
    (runtimeType) => runtimeType !== normalized.preferredRuntimeType
  );
}

/**
 * Whether `targetRuntimeType` may become the preferred Runtime for a Session.
 *
 * This is the Session-level authorization check only. Runtime availability,
 * Workspace capability and Tool requirements are separate preflight gates and
 * are deliberately not folded in here (Spec §7.2).
 */
export function isRuntimeSwitchTargetAuthorized(
  preference: RuntimePreference | undefined,
  targetRuntimeType: RuntimeType
): boolean {
  if (!isRuntimeType(targetRuntimeType)) return false;
  const allowed = normalizeRuntimePreference(preference)?.allowedRuntimeTypes;
  return allowed === undefined || allowed.includes(targetRuntimeType);
}

/**
 * Applies a switch to a Session preference, returning the next preference.
 *
 * `target_only` narrows the authorization set to the target; the other modes
 * leave authorization untouched and only move the preferred Runtime. The
 * revision always advances so a concurrent writer's CAS can detect the change.
 */
export function applyRuntimeSwitchToPreference(input: {
  preference?: RuntimePreference;
  targetRuntimeType: RuntimeType;
  fallbackMode: RuntimeSwitchFallbackMode;
}): RuntimePreference {
  const current = normalizeRuntimePreference(input.preference) ?? {};
  if (!isRuntimeSwitchTargetAuthorized(input.preference, input.targetRuntimeType)) {
    throw new Error('RUNTIME_SWITCH_TARGET_NOT_AUTHORIZED');
  }
  const nextRevision = (current.revision ?? 0) + 1;

  if (input.fallbackMode === 'target_only') {
    return {
      preferredRuntimeType: input.targetRuntimeType,
      fallbackRuntimeTypes: [],
      allowedRuntimeTypes: [input.targetRuntimeType],
      revision: nextRevision
    };
  }

  const allowedRuntimeTypes = current.allowedRuntimeTypes?.length
    ? Array.from(new Set([...current.allowedRuntimeTypes, input.targetRuntimeType]))
    : undefined;
  const fallbackRuntimeTypes = resolveFallbackRuntimeChain({
    ...current,
    ...(allowedRuntimeTypes ? { allowedRuntimeTypes } : {}),
    preferredRuntimeType: input.targetRuntimeType
  });

  return {
    preferredRuntimeType: input.targetRuntimeType,
    ...(allowedRuntimeTypes ? { allowedRuntimeTypes } : {}),
    fallbackRuntimeTypes,
    revision: nextRevision
  };
}

/**
 * Where a switch request is in its one-way lifecycle.
 *
 * The order encodes Spec I1: `applying` is only reachable from `stop_confirmed`,
 * so the target Runtime cannot take ownership while the previous invocation might
 * still hold it. A stop that is not confirmed keeps the request in `stopping`
 * rather than rewinding, because rewinding would reopen admission.
 */
export type RuntimeSwitchStatus =
  | 'requested'
  | 'preflighted'
  | 'stopping'
  | 'stop_confirmed'
  | 'applying'
  | 'resuming'
  | 'completed'
  | 'failed';

/** The stage a failure happened in, so only that stage is retried. */
export type RuntimeSwitchFailureStage = Exclude<RuntimeSwitchStatus, 'completed' | 'failed'>;

const RUNTIME_SWITCH_TRANSITIONS: Readonly<Record<RuntimeSwitchStatus, readonly RuntimeSwitchStatus[]>> = {
  requested: ['preflighted', 'failed'],
  // A Session with no active invocation has nothing to stop, so it may apply the
  // policy directly; one with an active invocation must go through the barrier.
  preflighted: ['stopping', 'stop_confirmed', 'failed'],
  stopping: ['stop_confirmed', 'failed'],
  stop_confirmed: ['applying', 'failed'],
  applying: ['resuming', 'completed', 'failed'],
  resuming: ['completed', 'failed'],
  completed: [],
  failed: []
};

export function canTransitionRuntimeSwitch(from: RuntimeSwitchStatus, to: RuntimeSwitchStatus): boolean {
  return RUNTIME_SWITCH_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminalRuntimeSwitchStatus(status: RuntimeSwitchStatus): boolean {
  return status === 'completed' || status === 'failed';
}

/**
 * Whether a failure in `stage` may be retried by re-running that same stage.
 *
 * Everything up to `applying` is a re-read or an idempotent commit, so retrying
 * is safe. `resuming` is not: a write task whose candidate is no longer trusted
 * would have to re-execute side effects that were never confirmed, which Spec I8
 * forbids without a human in the loop.
 */
export function canRetryRuntimeSwitchFrom(stage: RuntimeSwitchFailureStage): boolean {
  return stage !== 'resuming';
}

/**
 * One client Idempotency-Key against one Session is one switch request.
 *
 * The Session id is part of the key because a client may reuse its own key
 * across Sessions, and two Sessions must never collapse into one request.
 */
export function runtimeSwitchLogicalKey(input: { sessionId: string; idempotencyKey: string }): string {
  return [RUNTIME_SWITCH_CONTRACT_VERSION, input.sessionId, `key:${input.idempotencyKey}`].join('|');
}

/**
 * The outbox key for one status update of one request. Including the version is
 * what makes a replayed publish a no-op instead of a duplicate event, and what
 * lets a client drop an out-of-order update instead of rewinding its state.
 */
export function runtimeSwitchEventKey(input: { switchRequestId: string; version: number }): string {
  return `runtime-switch:${input.switchRequestId}:${input.version}`;
}

/**
 * A durable switch request. It is the only truth about "the user asked to change
 * Runtime": nothing about a switch may live solely in an in-flight promise or in
 * client state, because a restart has to be able to explain and finish it.
 */
export type RuntimeSwitchRequest = {
  id: UUID;
  sessionId: UUID;
  /** Which entry point asked, for audit; all of them use the same server path. */
  source: 'chat_command' | 'natural_language' | 'ui_control' | 'plugin';
  scope?: 'work_item' | 'session';
  timing?: 'immediate' | 'after_step';
  workItemId?: string;
  requestedBriefId?: string;
  previousPreference?: RuntimePreference;
  handoff?: RuntimeHandoffCheckpoint;
  firstAttemptGroupId?: string;
  fromRuntimeType?: RuntimeType;
  targetRuntimeType: RuntimeType;
  resumeAfterSwitch: boolean;
  fallbackMode: RuntimeSwitchFallbackMode;
  status: RuntimeSwitchStatus;
  /** Monotonic per request; every status update advances it exactly once. */
  version: number;
  /** The Session revision the client based its choice on, for CAS. */
  expectedSessionRevision?: number;
  /** Restored when the switch completes, so a paused Session resumes its stage. */
  previousSessionStatus?: string;
  stopRequestId?: UUID;
  stoppedInvocationIds: UUID[];
  /** The lifecycle generation the target Runtime owns; older ones may not write. */
  lifecycleGeneration?: number;
  idempotencyKey: string;
  failureStage?: RuntimeSwitchFailureStage;
  /** Safe summary only: never a raw provider response, credential or local path. */
  error?: { code: string; message: string; retryable: boolean };
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

/** Portable facts, never a native CLI conversation or hidden model reasoning. */
export type RuntimeHandoffCheckpoint = {
  version: '1.0';
  workItemId?: string;
  briefId?: string;
  sessionRevision: number;
  createdAt: string;
  tasks: Array<{ id: string; status: string; candidateId?: string; stage?: string }>;
  invocationIds: string[];
};

export type RuntimeSwitchInput = {
  targetRuntimeType: RuntimeType | 'fallback';
  resumeAfterSwitch?: boolean;
  fallbackMode?: RuntimeSwitchFallbackMode;
  scope?: 'work_item' | 'session';
  timing?: 'immediate' | 'after_step';
  expectedSessionRevision?: number;
  idempotencyKey: string;
};

/** An explicit task choice expires when a different WorkItem becomes active. */
export function effectiveRuntimePreference(session: Pick<SessionDetail, 'runtimePreference' | 'activeWorkItemId' | 'runtimeSwitchOverride' | 'runtimeFailover'>): RuntimePreference | undefined {
  const override = session.runtimeSwitchOverride;
  const preference = override && override.workItemId === session.activeWorkItemId
    ? override.preference : session.runtimePreference;
  const failover = session.runtimeFailover;
  if (failover && failover.workItemId === session.activeWorkItemId &&
      failover.preferenceRevision === (preference?.revision ?? 0) && isRuntimeSwitchTargetAuthorized(preference, failover.runtimeType)) {
    return { ...preference, preferredRuntimeType: failover.runtimeType, preferredModelId: undefined };
  }
  return preference;
}

/**
 * Whether a client's view of the Session is still current enough to act on.
 *
 * A switch replaces the execution owner, so a request built against a Session
 * the user can no longer see must be refused (409) rather than applied as a
 * last-writer-wins overwrite.
 */
export function isRuntimeSwitchRevisionCurrent(input: {
  expectedSessionRevision?: number;
  currentSessionRevision?: number;
}): boolean {
  if (input.expectedSessionRevision === undefined) return true;
  return input.expectedSessionRevision === (input.currentSessionRevision ?? 0);
}
