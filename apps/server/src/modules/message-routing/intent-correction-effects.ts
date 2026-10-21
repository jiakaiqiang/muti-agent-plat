import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { isIsolatedTestScope, type IntentCorrection, type IntentPlanStepRecord, type IntentRouteRevision,
  type LogicalOperation, type WorkspaceWritebackRecord } from '@agent-cluster/shared';
import type { PersistedState } from '../persistence/persistence.service.js';
import { testRunIdentityHash } from '../runtimes/isolated-test-run-store.js';
import type { ArtifactState } from '../artifacts/artifact-store.js';
import { testReportMetadata } from './intent-test-report.js';

/** Isolated scratch is discarded; published reports are verified and retained. Neither is an external rollback. */
export function reconcileCorrectionEffects(draft: PersistedState, correction: IntentCorrection): {
  state: 'ready' | 'pending' | 'unsupported'; receipts: NonNullable<IntentCorrection['effectReconciliation']>['executions'];
} {
  const rows = <T>(key: string) => (draft[key] as Record<string, T[]> | undefined)?.[correction.sessionId] ?? [];
  const receipts: NonNullable<IntentCorrection['effectReconciliation']>['executions'] = [];
  for (const invocationId of correction.affectedExecutionIds) {
    const operations = rows<LogicalOperation>('logicalOperationsBySession').filter(row => row.dataEpoch === correction.dataEpoch && row.invocationIds.includes(invocationId));
    if (operations.length !== 1) return { state: 'unsupported', receipts: [] };
    const operation = operations[0], binding = operation.executionBinding;
    const record = rows<IntentPlanStepRecord>('intentPlanStepsBySession').find(row => row.id === operation.intentStepId);
    const revision = binding && rows<IntentRouteRevision>('intentRouteRevisionsBySession').find(row => row.routingId === binding.routingId &&
      row.intentRevision === binding.intentRevision && row.dataEpoch === correction.dataEpoch);
    if (!binding || operation.phase !== 'task_execution' || operation.admissionClass !== 'business' || !operation.workItemId ||
      !correction.affectedWorkItemIds.includes(operation.workItemId) || !record || record.dataEpoch !== correction.dataEpoch ||
      record.step.target.workItemId !== operation.workItemId || !isDeepStrictEqual(record.step.executionBinding, binding) ||
      !isIsolatedTestScope(record.step.effectScope) || revision?.authorizationState !== 'validated' || revision.validatedPlan?.outcome !== 'applicable' ||
      !revision.validatedPlan.steps.some(step => isDeepStrictEqual(step, record.step)) ||
      (draft.workspaceWritebacks as WorkspaceWritebackRecord[] | undefined)?.some(row => row.sessionId === correction.sessionId && row.invocationId === invocationId)) {
      return { state: 'unsupported', receipts: [] };
    }
    const attempt = operation.isolatedTestAttempts?.find(row => row.invocationId === invocationId);
    const artifactState = draft.artifacts as ArtifactState | undefined;
    if (!record.resultArtifactId && Object.values(artifactState?.artifactsById ?? {}).some(artifact =>
      artifact.sessionId === correction.sessionId && (artifact.id === `intent-test-report:${record.id}` || artifact.metadata.intentTestReport?.stepId === record.id))) {
      return { state: 'unsupported', receipts: [] };
    }
    // A call interrupted before reaching the isolated runner has no disposal receipt; do not infer its effects.
    if (!attempt?.authorityBinding) return { state: 'unsupported', receipts: [] };
    const hash = testRunIdentityHash({ sessionId: correction.sessionId, dataEpoch: correction.dataEpoch, operationId: operation.id, invocationId });
    const authority = attempt.authorityBinding, scope = record.step.effectScope;
    if (attempt.identityHash !== hash || attempt.containerName !== `intent-test-${hash.slice(0, 40)}` ||
      attempt.imageId !== authority.imageId || attempt.script !== authority.script || authority.runnerId !== 'docker-npm-tests-v1' ||
      scope.effects.find(effect => effect.kind === 'run_tests')?.target.refId !== authority.resourceId || !revision.authorityGrants?.some(grant =>
        grant.effect === 'run_tests' && grant.resource.kind === 'test_runner' && grant.resource.refId === authority.resourceId && scope.grantIds.includes(grant.id))) {
      return { state: 'unsupported', receipts: [] };
    }
    if (operation.activeInvocationId || ['requested', 'unconfirmed'].includes(operation.stopState) ||
      !['finished', 'reconciled'].includes(attempt.phase) || !attempt.stopConfirmed || attempt.cleanupRequired) return { state: 'pending', receipts: [] };
    if (record.resultArtifactId) {
      const state = artifactState, artifact = state?.artifactsById[record.resultArtifactId];
      if (!artifact || artifact.id !== `intent-test-report:${record.id}` || artifact.sessionId !== correction.sessionId || artifact.dataEpoch !== correction.dataEpoch ||
        artifact.workItemId !== record.step.target.workItemId || artifact.type !== 'test_report' || !['completed', 'failed'].includes(record.status) ||
        attempt.phase !== 'finished' || !state?.artifactIdsBySession[correction.sessionId]?.includes(artifact.id) ||
        artifact.runtimeProposals?.length || artifact.platformProjections?.length || artifact.metadata.phase !== 'task_execution' ||
        artifact.metadata.status !== (attempt.result?.exitCode === 0 ? 'passed' : 'failed') || record.status !== (attempt.result?.exitCode === 0 ? 'completed' : 'failed') ||
        !scope.effects.some(effect => effect.kind === 'write_artifact') || !revision.authorityGrants?.some(grant => grant.effect === 'write_artifact' &&
          grant.resource.kind === 'artifact' && grant.resource.refId === `test-report:${authority.bindingHash}` && scope.grantIds.includes(grant.id))) {
        return { state: 'unsupported', receipts: [] };
      }
      try { if (!isDeepStrictEqual(artifact.metadata.intentTestReport, testReportMetadata(record, attempt))) return { state: 'unsupported', receipts: [] }; }
      catch { return { state: 'unsupported', receipts: [] }; }
      receipts.push({ invocationId, operationId: operation.id, bindingHash: authority.bindingHash, snapshotHash: attempt.snapshotHash,
        disposition: 'published_report_retained', resultKnown: true, artifactId: artifact.id,
        artifactContentHash: createHash('sha256').update(artifact.metadata.intentTestReport!.content).digest('hex') });
      continue;
    }
    receipts.push({ invocationId, operationId: operation.id, bindingHash: authority.bindingHash, snapshotHash: attempt.snapshotHash,
      disposition: 'isolated_scratch_discarded', resultKnown: Boolean(attempt.result && attempt.result.error !== 'ISOLATED_TEST_RESULT_LOST') });
  }
  return { state: 'ready', receipts };
}
