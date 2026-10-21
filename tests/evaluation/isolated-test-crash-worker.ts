// Test-only process: the parent kills this process after Docker confirms the container is running.
import { PersistenceService } from '../../apps/server/src/modules/persistence/persistence.service.js';
import { IsolatedTestRunnerService } from '../../apps/server/src/modules/runtimes/isolated-test-runner.service.js';
const [filePath, workingDirectory] = process.argv.slice(2);
const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath });
await persistence.initialize();
const runner = new IsolatedTestRunnerService(persistence);
const result = await runner.run({ workingDirectory, script: 'test', timeoutMs: 120_000,
  execution: { sessionId: 'session', dataEpoch: 'epoch', operationId: 'operation', invocationId: 'invocation' } });
console.log(JSON.stringify(result));
await persistence.onModuleDestroy();
