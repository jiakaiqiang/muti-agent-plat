import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

let server;

try {
  server = await startSmokeServer('task-dependency-smoke', {
    DISCUSSION_MAX_ROUNDS: '0'
  });

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Task dependency smoke should run dependent tasks in order.'
  );
  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED');

  const tasksResponse = await api(server.apiBase, `/sessions/${sessionId}/tasks`);
  const tasks = tasksResponse.data;
  const dependentTask = tasks.find((task) => task.dependsOnTaskIds?.length);
  if (!dependentTask) {
    throw new Error(`Expected at least one dependent task: ${JSON.stringify(tasks)}`);
  }
  const dependencyId = dependentTask.dependsOnTaskIds[0];
  const events = await listEvents(server.apiBase, sessionId);
  const dependencyCompletedAt = events.findIndex(
    (event) => event.type === 'task_completed' && event.taskId === dependencyId
  );
  const dependentStartedAt = events.findIndex(
    (event) => event.type === 'task_started' && event.taskId === dependentTask.id
  );
  if (dependencyCompletedAt < 0 || dependentStartedAt < 0 || dependencyCompletedAt > dependentStartedAt) {
    throw new Error('Dependent task must start only after its dependency completes');
  }

  console.log('task dependency smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
