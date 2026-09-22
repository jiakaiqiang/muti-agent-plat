import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRuntimePricingCatalog } from '../modules/runtimes/runtime-pricing.js';

const truthy = new Set(['1', 'true', 'yes', 'on']);
const rolloutModes = new Set(['disabled', 'shadow', 'enforce_new_sessions', 'enforce_selected_sessions', 'enforce_all_current_epoch']);

type Gate = { id: string; status: 'passed' | 'blocked'; detail: string };
type RollbackEvidence = {
  schemaVersion?: string;
  result?: string;
  executedAt?: string;
  fixtureHashes?: Record<string, unknown>;
};

export function parseTraceabilitySummary(markdown: string) {
  const match = markdown.match(/passed：(\d+)；partial：(\d+)；pending：(\d+)；not-executed：(\d+)(?:；deferred：(\d+))?；failed\/missing：(\d+)/);
  if (!match) throw new Error('PHASE_6_TRACEABILITY_INVALID: summary counts are missing.');
  const hasDeferredColumn = match[6] !== undefined;
  const counts = {
    passed: Number(match[1]),
    partial: Number(match[2]),
    pending: Number(match[3]),
    notExecuted: Number(match[4]),
    deferred: Number(hasDeferredColumn ? match[5] : 0),
    failedOrMissing: Number(hasDeferredColumn ? match[6] : match[5])
  };
  if (markdown.includes('## 矩阵')) {
    const rows = [...markdown.matchAll(/^\| ([0-9]+[a-z]?) \| (P[0-9]+[A-Z]?-AC\d+) \| .*? \| (passed|partial|pending|not-executed|deferred|failed|missing) \|/gm)];
    const actual = { passed: 0, partial: 0, pending: 0, notExecuted: 0, deferred: 0, failedOrMissing: 0 };
    const seen = new Set<string>();
    for (const [, phase, id, status] of rows) {
      if (seen.has(id) || !id.startsWith(`P${phase.toUpperCase()}-`)) {
        throw new Error('PHASE_6_TRACEABILITY_INVALID: duplicate or incorrectly scoped AC row.');
      }
      seen.add(id);
      if (status === 'not-executed') actual.notExecuted += 1;
      else if (status === 'deferred') actual.deferred += 1;
      else if (status === 'failed' || status === 'missing') actual.failedOrMissing += 1;
      else if (status === 'passed' || status === 'partial' || status === 'pending') actual[status] += 1;
    }
    if (rows.length === 0 || Object.keys(counts).some((key) => counts[key as keyof typeof counts] !== actual[key as keyof typeof counts])) {
      throw new Error('PHASE_6_TRACEABILITY_INVALID: summary and AC rows disagree.');
    }
  }
  return counts;
}

export function buildPhase6ReleasePreflight(input: {
  env?: NodeJS.ProcessEnv;
  traceability?: string;
  postgresEvidence?: RollbackEvidence;
} = {}) {
  const env = input.env ?? process.env;
  const counts = parseTraceabilitySummary(input.traceability ?? '');
  const intentRoutingMode = env.INTENT_ROUTING_MODE?.trim() || 'shadow';
  const discussionEnabled = flag(env.MAIN_AGENT_DISCUSSION_ENABLED);
  const requirementDocumentEnabled = flag(env.REQUIREMENT_DOCUMENT_ENABLED);
  const approvalRecorded = Boolean(env.PHASE_6_RELEASE_APPROVAL_ID?.trim());
  const buildIdentityComplete = Boolean(env.AGENT_CLUSTER_COMMIT?.trim() && env.AGENT_CLUSTER_BUILD_TIME?.trim());
  const rollbackVerified = Boolean(validRollbackEvidence(input.postgresEvidence));
  const acceptanceComplete = counts.partial === 0 && counts.pending === 0 && counts.notExecuted === 0 && counts.failedOrMissing === 0;
  const policyEnablementRequested = intentRoutingMode.startsWith('enforce_') || discussionEnabled || requirementDocumentEnabled;
  const policySafe = rolloutModes.has(intentRoutingMode) &&
    (!policyEnablementRequested || (acceptanceComplete && rollbackVerified && buildIdentityComplete && approvalRecorded));
  const pricing = pricingStatus(env.AGENT_CLUSTER_RUNTIME_PRICING_JSON);
  const gates: Gate[] = [
    gate('traceability_integrity', counts.failedOrMissing === 0, counts.failedOrMissing === 0 ? 'no failed or missing AC evidence' : 'failed or missing AC evidence remains'),
    gate('phase_6_acceptance_complete', acceptanceComplete, acceptanceComplete ? 'all AC evidence is complete' : 'partial, pending, or not-executed AC evidence remains'),
    gate('isolated_postgres_rollback_verified', rollbackVerified, rollbackVerified ? 'sanitized rollback evidence is present' : 'successful isolated PostgreSQL rollback evidence is absent'),
    gate('build_identity_complete', buildIdentityComplete, buildIdentityComplete ? 'commit and build time are configured' : 'AGENT_CLUSTER_COMMIT or AGENT_CLUSTER_BUILD_TIME is missing'),
    gate('release_authorization_recorded', approvalRecorded, approvalRecorded ? 'an approval record id is configured' : 'PHASE_6_RELEASE_APPROVAL_ID is missing'),
    gate('runtime_pricing_valid', pricing.valid, pricing.valid ? (pricing.configured ? 'runtime pricing catalog is valid' : 'runtime pricing is intentionally unconfigured') : 'runtime pricing catalog is invalid'),
    gate('policy_admission_safe', policySafe, policySafe ? 'policy remains disabled or all admission prerequisites are satisfied' : 'policy enablement would bypass an incomplete admission gate')
  ];
  const blockers = gates.filter((item) => item.status === 'blocked').map((item) => item.id);
  return {
    schemaVersion: 'phase-6-release-preflight-v1',
    result: blockers.length === 0 ? 'ready' : 'blocked',
    effectiveConfig: {
      intentRoutingMode: rolloutModes.has(intentRoutingMode) ? intentRoutingMode : 'invalid',
      mainAgentDiscussionEnabled: discussionEnabled,
      requirementDocumentEnabled,
      policyEnablementRequested,
      isolatedTestDatabaseConfigured: Boolean(env.RELATIONAL_TEST_DATABASE_URL?.trim()),
      runtimePricingConfigured: pricing.configured,
      runtimePricingValid: pricing.valid,
      buildCommitConfigured: Boolean(env.AGENT_CLUSTER_COMMIT?.trim()),
      buildTimeConfigured: Boolean(env.AGENT_CLUSTER_BUILD_TIME?.trim()),
      releaseApprovalConfigured: approvalRecorded
    },
    traceability: counts,
    gates,
    blockers,
    warnings: [
      ...(!env.AGENT_CLUSTER_RUNTIME_PRICING_JSON?.trim() ? ['runtime pricing is not configured; monetary cost remains unknown'] : []),
      ...(!env.RELATIONAL_TEST_DATABASE_URL?.trim() && !rollbackVerified
        ? ['isolated PostgreSQL test URL is not configured; no rollback drill evidence is available']
        : [])
    ]
  };
}

export function assertPhase6ProductionPolicyAdmission(
  env: NodeJS.ProcessEnv = process.env,
  evidence?: { traceability: string; postgresEvidence?: RollbackEvidence }
) {
  if (!flag(env.MAIN_AGENT_DISCUSSION_ENABLED) && !flag(env.REQUIREMENT_DOCUMENT_ENABLED) &&
      !(env.INTENT_ROUTING_MODE?.trim() ?? '').startsWith('enforce_')) return;
  if (env.NODE_ENV?.trim().toLowerCase() === 'test' &&
      env.PHASE_6_POLICY_ADMISSION_BYPASS?.trim() === 'isolated_test_only') return;

  // An enabled policy must ship its verified evidence; only explicit isolated tests bypass release admission.
  const traceabilityPath = resolve(env.PHASE_6_TRACEABILITY_PATH?.trim() || 'docs/quality/main-agent-collaboration-phase-6-traceability-matrix-v1.md');
  const rollbackPath = resolve(env.PHASE_6_POSTGRES_EVIDENCE_PATH?.trim() || '.cache/agent-cluster/phase-6/postgres-migration-evidence.json');
  try {
    const traceability = evidence?.traceability ?? readFileSync(traceabilityPath, 'utf8');
    if (!traceability.includes('## 矩阵')) throw new Error('PHASE_6_TRACEABILITY_INVALID: AC rows are required at production startup.');
    const rollback = evidence?.postgresEvidence ?? (existsSync(rollbackPath) ? JSON.parse(readFileSync(rollbackPath, 'utf8')) : undefined);
    const report = buildPhase6ReleasePreflight({ env, traceability, postgresEvidence: rollback });
    if (report.result !== 'ready') throw new Error(`PHASE_6_POLICY_ADMISSION_BLOCKED: ${report.blockers.join(', ')}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('PHASE_6_POLICY_ADMISSION_BLOCKED:')) throw error;
    throw new Error('PHASE_6_POLICY_ADMISSION_BLOCKED: required release evidence is unavailable or invalid.');
  }
}

function pricingStatus(raw: string | undefined) {
  if (!raw?.trim()) return { configured: false, valid: true };
  try {
    parseRuntimePricingCatalog(raw);
    return { configured: true, valid: true };
  } catch {
    return { configured: true, valid: false };
  }
}

function validRollbackEvidence(value: RollbackEvidence | undefined) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const hashes = value.fixtureHashes;
  return value.schemaVersion === 'phase-6-postgres-migration-evidence-v1' &&
    value.result === 'passed' &&
    typeof value.executedAt === 'string' && Number.isFinite(Date.parse(value.executedAt)) &&
    Boolean(hashes) && typeof hashes === 'object' && !Array.isArray(hashes) &&
    ['source1', 'source2', 'rollback'].every((key) => typeof hashes[key] === 'string' && /^[a-f0-9]{64}$/.test(hashes[key]));
}

function flag(value: string | undefined) {
  return typeof value === 'string' && truthy.has(value.trim().toLowerCase());
}

function gate(id: string, passed: boolean, detail: string): Gate {
  return { id, status: passed ? 'passed' : 'blocked', detail };
}
