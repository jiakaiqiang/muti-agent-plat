import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { INTENT_TEST_SCRIPTS, type IntentEffectGrant, type IntentTestAuthority, type IntentTestRunnerBinding,
  type IntentTestScript, type SessionDetail } from '@agent-cluster/shared';
import { currentWorkspaceReadGrant, workspaceReadBindingHash } from './intent-workspace-read.js';
import { currentSourceGrants } from './intent-source-authority.js';

/** Configuration and validated workspace facts only. Model output cannot select an image or shell. */
export function testRunnerBinding(session: SessionDetail, script: IntentTestScript,
  imageId = process.env.INTENT_ISOLATED_TEST_IMAGE): IntentTestRunnerBinding | undefined {
  const workspaceBindingHash = workspaceReadBindingHash(session);
  if (!workspaceBindingHash || !session.workspaceContext?.binding?.capabilities.test || !imageId ||
    !/^sha256:[a-f0-9]{64}$/.test(imageId) || !INTENT_TEST_SCRIPTS.includes(script)) return;
  const body = { runnerId: 'docker-npm-tests-v1' as const, workspaceBindingHash, workspaceId: session.workspaceId, imageId, script };
  const bindingHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return { ...body, bindingHash, resourceId: `test-runner:${bindingHash}` };
}

export function availableTestRunnerBindings(session: SessionDetail): IntentTestRunnerBinding[] {
  return INTENT_TEST_SCRIPTS.flatMap(script => { const binding = testRunnerBinding(session, script); return binding ? [binding] : []; });
}

export function issueTestAuthority(session: SessionDetail, script: IntentTestScript, sourceEventId: string, revision: number, writeReport = false): IntentTestAuthority | undefined {
  const binding = testRunnerBinding(session, script);
  if (!binding) return;
  return { binding, grant: { id: `isolated-test:${session.id}:${binding.bindingHash}`, effect: 'run_tests',
    resource: { kind: 'test_runner', refId: binding.resourceId }, revision, sourceEventId },
    ...(writeReport ? { reportGrant: { id: `isolated-test-report:${session.id}:${binding.bindingHash}`, effect: 'write_artifact' as const,
      resource: { kind: 'artifact' as const, refId: `test-report:${binding.bindingHash}` }, revision, sourceEventId } } : {}) };
}

export function currentTestReportGrant(session: SessionDetail): IntentEffectGrant | undefined {
  const test = currentTestGrant(session), authority = session.intentTestAuthority, grant = authority?.reportGrant;
  if (!test || !authority || !grant || grant.revokedAt || grant.revision !== test.revision || grant.sourceEventId !== test.sourceEventId ||
    grant.id !== `isolated-test-report:${session.id}:${authority.binding.bindingHash}` || grant.effect !== 'write_artifact' ||
    grant.resource.kind !== 'artifact' || grant.resource.refId !== `test-report:${authority.binding.bindingHash}`) return;
  return grant;
}

export function currentTestGrant(session: SessionDetail): IntentEffectGrant | undefined {
  const authority = session.intentTestAuthority;
  if (!authority || authority.grant.revokedAt || !Number.isSafeInteger(authority.grant.revision) || authority.grant.revision < 1 ||
    !isDeepStrictEqual(authority.binding, testRunnerBinding(session, authority.binding.script)) ||
    authority.grant.id !== `isolated-test:${session.id}:${authority.binding.bindingHash}` || authority.grant.effect !== 'run_tests' ||
    authority.grant.resource.kind !== 'test_runner' || authority.grant.resource.refId !== authority.binding.resourceId) return;
  return authority.grant;
}

/** Bounded snapshot data. These are candidates/grants, not capability or dispatch approval. */
export function intentEffectAuthoritySnapshot(session: SessionDetail) {
  const testRunnerBindings = availableTestRunnerBindings(session);
  const grants = [currentWorkspaceReadGrant(session), currentTestGrant(session), currentTestReportGrant(session), ...currentSourceGrants(session)].filter((grant): grant is IntentEffectGrant => Boolean(grant));
  return { grants: structuredClone(grants), testRunnerBindings,
    resources: [{ kind: 'workspace' as const, refId: session.workspaceId }, ...currentSourceGrants(session).map(grant => grant.resource),
      ...testRunnerBindings.flatMap(binding => [{ kind: 'test_runner' as const, refId: binding.resourceId },
        { kind: 'artifact' as const, refId: `test-report:${binding.bindingHash}` }])] };
}
