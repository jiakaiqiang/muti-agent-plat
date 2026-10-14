import type { DeliveryRecord, GitTaskCandidate } from '@agent-cluster/shared';

export function recordDeliveryCandidate(
  current: DeliveryRecord | undefined,
  candidate: GitTaskCandidate,
  baseBranch: string,
  now: string
): DeliveryRecord {
  if (current?.candidates?.some((item) => item.id === candidate.id)) return current;
  const active = current?.state === 'merged' ? undefined : current;
  return {
    ...(active ?? {}),
    sessionId: candidate.sessionId,
    round: active?.round ?? (current ? current.round + 1 : 1),
    state: 'awaiting_validation_input',
    version: (active?.version ?? 0) + 1,
    baseBranch,
    candidates: [...(active?.candidates ?? []).filter((item) => item.taskId !== candidate.taskId), candidate],
    candidateTreeSha: undefined,
    changedPaths: undefined,
    conflictPaths: undefined,
    conflictId: undefined,
    validation: undefined,
    validationCommand: undefined,
    publishParentSha: undefined,
    mergeOperationKey: undefined,
    mergeExpectedHeadSha: undefined,
    errorCode: undefined,
    ...(active ? {} : {
      taskBranch: undefined, commitSha: undefined, pullRequestNumber: undefined,
      pullRequestUrl: undefined, reviewedHeadSha: undefined, mergedCommitSha: undefined,
      ciStatus: undefined, operationKeys: undefined
    }),
    createdAt: active?.createdAt ?? now,
    updatedAt: now
  };
}
