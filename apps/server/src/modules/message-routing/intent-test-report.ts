import type { ArtifactMetadata, IntentPlanStepRecord, IsolatedTestAttempt } from '@agent-cluster/shared';

/** Canonical evidence rendering shared by publication and later reconciliation. No runtime-supplied report text. */
export function testReportMetadata(record: IntentPlanStepRecord, attempt: IsolatedTestAttempt): NonNullable<ArtifactMetadata['intentTestReport']> {
  const result = attempt.result;
  if (!attempt.authorityBinding || !attempt.snapshotHash || !/^[a-f0-9]{64}$/.test(attempt.snapshotHash) || !result || result.exitCode === null ||
    result.aborted || result.timedOut || (result.error && !(result.error === 'ISOLATED_TEST_FAILED' && result.exitCode !== 0))) {
    throw new Error('INTENT_TEST_REPORT_EVIDENCE_INCOMPLETE');
  }
  const output = JSON.stringify({ stdout: result.stdout.slice(0, 16000), stderr: result.stderr.slice(0, 16000),
    truncated: result.outputTruncated || result.stdout.length > 16000 || result.stderr.length > 16000 }, null, 2);
  const fence = '`'.repeat(Math.max(3, ...[...output.matchAll(/`+/g)].map(match => match[0].length + 1)));
  const content = `# 隔离测试报告：${attempt.script}\n\n退出码：${result.exitCode}\n\n源码快照 SHA-256：${attempt.snapshotHash}\n\n${fence}json\n${output}\n${fence}\n`;
  return { format: 'markdown', content, stepId: record.id, invocationId: attempt.invocationId, bindingHash: attempt.authorityBinding.bindingHash,
    snapshotHash: attempt.snapshotHash, script: attempt.authorityBinding.script, exitCode: result.exitCode,
    ...(record.supersedesArtifactIds?.length ? { supersedesArtifactIds: [...record.supersedesArtifactIds] } : {}) };
}
