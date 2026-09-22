import { writeFileSync } from 'node:fs';
import { PersistenceService } from '../apps/server/src/modules/persistence/persistence.service.ts';

const [mode, statePath, readyPath] = process.argv.slice(2);
if (!mode || !statePath) throw new Error('mode and statePath are required');

const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath: statePath });
await persistence.initialize();

if (mode === 'claim') {
  const claimed = await persistence.claimPendingEventOutbox(`worker:${process.pid}`, 1, 250);
  if (claimed.length !== 1) throw new Error('record was not claimable');
  if (readyPath) writeFileSync(readyPath, 'ready\n', 'utf8');
  setInterval(() => undefined, 1_000);
} else if (mode === 'reclaim') {
  const claimed = await persistence.claimPendingEventOutbox(`worker:${process.pid}`, 1, 250);
  if (claimed.length !== 1) throw new Error('record was not reclaimable after lease expiry');
  await persistence.markEventPublished('crash-restart-1');
} else {
  throw new Error(`unknown mode: ${mode}`);
}
