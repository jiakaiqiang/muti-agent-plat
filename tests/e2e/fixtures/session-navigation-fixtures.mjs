// Anonymous, deterministic fixtures. No workspace paths, user content or Runtime calls.
export function navigationFixture(id, count) {
  const date = '2026-09-29T00:00:00.000Z';
  const session = { id, title: `导航测试 ${id}`, originalInput: `匿名需求 ${id}`, dataEpoch: 'test',
    status: 'COMPLETED', ownerId: 'test', workspaceId: 'test', participatingAgentIds: [],
    tokenUsed: 0, tokenBudget: 70000, createdAt: date, updatedAt: date };
  const events = Array.from({ length: count }, (_, index) => ({
    id: `${id}-${index}`, sessionId: id, type: 'agent_message', fromAgentId: 'fixture-agent', toAgentIds: [],
    content: `匿名消息 ${id} #${index}\n${'这是用于验证会话切换的历史内容。'.repeat(index % 7 + 1)}`,
    metadata: { schemaVersion: '0.1', renderAs: 'chat_message', payload: {} },
    createdAt: new Date(Date.parse(date) + index * 1000).toISOString()
  }));
  for (let index = 20; index < count - 2; index += 100) {
    events[index] = { ...events[index], type: 'user_confirmation_requested', metadata: {
      schemaVersion: '0.1', renderAs: 'confirmation_card', payload: {
        confirmationId: `${id}-card-${index}`, reason: 'select_workflow', title: '选择工作流',
        options: [{ key: 'approve', label: '确认' }], workflowOptions: []
      }
    } };
    events[index + 1] = { ...events[index + 1], type: 'user_confirmation_resolved', metadata: {
      schemaVersion: '0.1', renderAs: 'system_notice', payload: { confirmationId: `${id}-card-${index}`, status: 'approved' }
    } };
    events[index + 2] = { ...events[index + 2], type: 'discussion_document_published', metadata: {
      schemaVersion: '0.1', renderAs: 'discussion_document', payload: {
        documentId: `${id}-doc-${index}`, revision: 1, title: '匿名需求文档',
        contentUrl: `/api/sessions/${id}/discussion-documents/doc-${index}/content`
      }
    } };
  }
  return { session, events };
}
export const navigationFixtures = [navigationFixture('A', 174), navigationFixture('B', 332), navigationFixture('C', 1571)];
