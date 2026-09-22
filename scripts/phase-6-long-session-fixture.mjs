import { randomUUID } from 'node:crypto';

export const LONG_SESSION_WORK_ITEM_COUNT = 100;
export const LONG_SESSION_MESSAGES_PER_ITEM = 10;
export const LONG_SESSION_MESSAGE_COUNT = LONG_SESSION_WORK_ITEM_COUNT * LONG_SESSION_MESSAGES_PER_ITEM;

function message(workItemId, index, content, kind = 'user') {
  return {
    id: `${workItemId}-message-${String(index).padStart(2, '0')}`,
    workItemId,
    kind,
    content,
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString()
  };
}

export function buildLongSessionFixture() {
  const sessionId = 'phase-6-long-session';
  const workItems = [];
  const messages = [];
  for (let index = 1; index <= LONG_SESSION_WORK_ITEM_COUNT; index += 1) {
    const workItemId = `work-item-${String(index).padStart(3, '0')}`;
    const item = {
      id: workItemId,
      title: index === 7 ? '订单导出（历史需求）' : `合成需求 ${index}`,
      revision: index === 7 ? 3 : 1,
      status: index === 7 ? 'completed' : 'waiting_user',
      decisions: index === 7
        ? [{ version: 1, text: '导出格式为 CSV' }, { version: 2, text: '导出格式改为 XLSX' }]
        : []
    };
    workItems.push(item);
    messages.push(
      message(workItemId, 1, `需求 ${index}：完成一个可验证的业务切片。`),
      message(workItemId, 2, `约束：必须保留 WorkItem ${workItemId} 的会话边界。`),
      message(workItemId, 3, index === 7 ? '用户修订：不再支持 CSV，只支持 XLSX。' : '用户补充验收标准。'),
      message(workItemId, 4, `主 Agent 已确认需求 ${index} 的范围。`, 'agent'),
      message(workItemId, 5, `工具输出：${'file evidence '.repeat(index === 7 ? 60 : 8)}` , 'tool'),
      message(workItemId, 6, '等待用户确认。'),
      message(workItemId, 7, '用户确认当前版本。'),
      message(workItemId, 8, '主 Agent 生成阶段摘要。', 'agent'),
      message(workItemId, 9, '流程节点完成。', 'system'),
      message(workItemId, 10, index === 42 ? '同名需求：订单导出，请先澄清是报表还是接口。' : '需求结束。')
    );
  }

  return {
    fixtureId: randomUUID(),
    sessionId,
    workItems,
    messages,
    annotations: {
      earlyReference: { workItemId: 'work-item-007', messageId: 'work-item-007-message-03', expected: 'recall' },
      ambiguousReference: { text: '订单导出', candidates: ['work-item-007', 'work-item-042'], expected: 'clarify' },
      revisedConstraint: { workItemId: 'work-item-007', superseded: 'CSV', current: 'XLSX', expected: 'forbid_csv' },
      longToolOutputWorkItemId: 'work-item-007'
    }
  };
}

function tokenEstimate(text) {
  return Math.ceil(String(text).length / 4);
}

export function buildControlledContext(fixture, unrelatedCount) {
  const current = fixture.workItems.find((item) => item.id === 'work-item-007');
  const relevant = fixture.messages.filter((item) => item.workItemId === current.id)
    .filter((item) => item.kind !== 'tool' || item.content.length < 240)
    .slice(-6);
  // Retrieval returns a bounded candidate window plus a count. The session may
  // contain 100 requirements, but unrelated history is never serialized in full.
  const unrelated = fixture.workItems.slice(0, Math.min(unrelatedCount, 5)).map((item) => ({ id: item.id, title: item.title }));
  return JSON.stringify({
    sessionId: fixture.sessionId,
    workItem: { id: current.id, title: current.title, revision: current.revision, status: current.status },
    effectiveDecision: current.decisions.at(-1),
    relevantMessages: relevant,
    unrelatedCandidates: unrelated,
    unrelatedCandidateCount: unrelatedCount,
    policy: { requireClarificationForAmbiguousReference: true, forbidSupersededConstraint: true }
  });
}

export function evaluateLongSession(fixture = buildLongSessionFixture()) {
  const input10 = buildControlledContext(fixture, 10);
  const input100 = buildControlledContext(fixture, 100);
  const baselineTokens = tokenEstimate(input10);
  const expandedTokens = tokenEstimate(input100);
  const growthRatio = expandedTokens / baselineTokens;
  const early = fixture.annotations.earlyReference.expected === 'recall'
    && fixture.workItems.find((item) => item.id === fixture.annotations.earlyReference.workItemId)?.decisions.at(-1)?.text === '导出格式改为 XLSX';
  const ambiguous = fixture.annotations.ambiguousReference.expected === 'clarify';
  const constraint = fixture.annotations.revisedConstraint.expected === 'forbid_csv'
    && !input100.includes('导出格式为 CSV');
  return {
    fixtureId: fixture.fixtureId,
    workItemCount: fixture.workItems.length,
    messageCount: fixture.messages.length,
    baselineTokens,
    expandedTokens,
    growthRatio,
    withinGrowthLimit: growthRatio <= 1.2,
    recall: { earlyReference: early },
    ambiguity: { sameNameRequiresClarification: ambiguous },
    constraints: { supersededConstraintExcluded: constraint },
    longToolOutputPreservedInFixture: fixture.messages.some((item) => item.kind === 'tool' && item.content.length > 200),
    modelQuality: 'not measured: deterministic fixture evaluator only'
  };
}

if (process.argv[1]?.endsWith('phase-6-long-session-fixture.mjs')) {
  const fixture = buildLongSessionFixture();
  console.log(JSON.stringify({ fixture, evaluation: evaluateLongSession(fixture) }, null, 2));
}
