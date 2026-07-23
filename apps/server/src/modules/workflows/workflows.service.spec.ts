import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowsController } from './workflows.controller.js';
import { WorkflowsService } from './workflows.service.js';

function setup() {
  const collections = new Map<string, unknown>();
  const persistence = {
    getCollection: (_key: string, fallback: unknown) => fallback,
    setCollection: (key: string, value: unknown) => collections.set(key, value)
  };
  const agents = {
    getByIdOrKey: (id: string) => {
      if (!['requirements', 'product', 'frontend'].includes(id)) throw new Error(`Agent not found: ${id}`);
      return { id };
    }
  };
  const service = new WorkflowsService(persistence as never, agents as never);
  return { service, collections };
}

test('WorkflowsService manages multiple workflows and canonical linear edges', () => {
  const { service, collections } = setup();
  const first = service.create({ name: 'Delivery flow' });
  service.create({ name: 'Review flow' });
  const updated = service.update(first.id, {
    nodes: [
      { id: 'node-2', type: 'agent', agentId: 'frontend', order: 2 },
      { id: 'node-1', type: 'agent', agentId: 'requirements', order: 0 },
      { id: 'node-3', type: 'agent', agentId: 'product', order: 1 }
    ]
  });

  assert.equal(service.list().length, 2);
  assert.deepEqual(
    updated.nodes.filter((node) => node.type === 'agent').map((node) => node.agentId),
    ['requirements', 'product', 'frontend']
  );
  assert.deepEqual(updated.edges.map((edge) => [edge.sourceNodeId, edge.targetNodeId]), [
    ['node-1', 'node-3'],
    ['node-3', 'node-2']
  ]);
  assert.equal(updated.draftRevision, 2);
  assert.equal((collections.get('workflows') as unknown[]).length, 2);
});

test('WorkflowsService rejects duplicate names and unknown agents', () => {
  const { service } = setup();
  service.create({ name: 'Release' });
  assert.throws(() => service.create({ name: 'release' }), /already exists/);
  assert.throws(
    () => service.create({
      name: 'Invalid',
      nodes: [{ id: 'node-1', type: 'agent', agentId: 'missing', order: 0 }]
    }),
    /Agent not found/
  );
});

test('WorkflowsService restores persisted workflows before Agent dependency initialization completes', () => {
  const now = '2026-07-13T00:00:00.000Z';
  const persisted = [{
    id: 'workflow-1',
    name: 'Persisted flow',
    status: 'draft',
    version: 1,
    nodes: [{ id: 'node-1', type: 'agent', agentId: 'requirements', order: 0 }],
    edges: [],
    createdAt: now,
    updatedAt: now
  }];
  const persistence = {
    getCollection: () => persisted,
    setCollection() {}
  };
  const service = new WorkflowsService(persistence as never, undefined as never);

  assert.deepEqual(service.list()[0]?.nodes, [
    { id: 'node-1', type: 'agent', agentId: 'requirements', order: 0, inputContract: [], outputContract: [] }
  ]);
});

test('WorkflowsService migrates a legacy published Agent flow into an immutable version with explicit gates', () => {
  const now = '2026-07-13T00:00:00.000Z';
  const persisted = [{
    id: 'workflow-legacy', name: 'Legacy published flow', status: 'published', version: 4,
    nodes: [
      { id: 'node-1', type: 'agent', agentId: 'requirements', order: 0 },
      { id: 'node-2', type: 'agent', agentId: 'frontend', order: 1 }
    ],
    edges: [], createdAt: now, updatedAt: now
  }];
  const writes = new Map<string, unknown>();
  const service = new WorkflowsService({
    getCollection: () => persisted,
    setCollection: (key: string, value: unknown) => writes.set(key, value)
  } as never, undefined as never);

  const workflow = service.get('workflow-legacy');
  const version = service.getVersion('workflow-legacy', 1);
  assert.equal(workflow.currentPublishedVersion, 1);
  assert.deepEqual(version.nodes.map((node) => node.type), ['agent', 'human_approval', 'agent', 'human_approval']);
  assert.equal(version.publishedBy, 'migration');
  assert.ok(writes.has('workflowCatalog'));
});

test('WorkflowsService publishes immutable versions with explicit approval nodes', () => {
  const { service } = setup();
  const draft = service.create({
    name: 'Approval flow',
    nodes: [
      { id: 'agent-1', type: 'agent', agentId: 'requirements', order: 0 },
      {
        id: 'human-1',
        type: 'human_approval',
        title: '确认需求',
        assignee: 'session_owner',
        allowedDecisions: ['approve', 'revise', 'cancel'],
        order: 1
      },
      {
        id: 'robot-1',
        type: 'robot_approval',
        reviewerAgentId: 'product',
        reviewPrompt: '检查需求是否完整',
        criteria: ['范围明确'],
        maxRevisionAttempts: 2,
        fallback: 'human_approval',
        order: 2
      }
    ]
  });
  const published = service.publish(draft.id, { expectedDraftRevision: draft.draftRevision });
  const version = service.getVersion(draft.id);

  assert.equal(published.status, 'published');
  assert.equal(published.currentPublishedVersion, 1);
  assert.equal(version.nodes.length, 3);
  assert.deepEqual(version.involvedAgentIds, ['requirements', 'product']);

  service.update(draft.id, { description: 'changed', expectedDraftRevision: published.draftRevision });
  assert.equal(service.getVersion(draft.id, 1).description, undefined);
});

test('WorkflowsService rejects invalid robot approval and stale draft updates', () => {
  const { service } = setup();
  const draft = service.create({
    name: 'Review validation',
    nodes: [
      { id: 'agent-1', type: 'agent', agentId: 'requirements', order: 0 },
      {
        id: 'robot-1',
        type: 'robot_approval',
        reviewerAgentId: 'product',
        reviewPrompt: '',
        criteria: [],
        maxRevisionAttempts: 2,
        fallback: 'human_approval',
        order: 1
      }
    ]
  });
  assert.throws(() => service.publish(draft.id), /prompt and criteria/);
  assert.throws(
    () => service.update(draft.id, { description: 'stale', expectedDraftRevision: 999 }),
    /Workflow draft revision changed/
  );
});

test('WorkflowsController exposes workflow CRUD', () => {
  const { service } = setup();
  const controller = new WorkflowsController(service);
  const created = controller.create({ name: 'Controller flow' }) as { data: { id: string } };
  assert.equal((controller.detail(created.data.id) as { data: { name: string } }).data.name, 'Controller flow');
  assert.equal((controller.remove(created.data.id) as { data: { removed: boolean } }).data.removed, true);
});
