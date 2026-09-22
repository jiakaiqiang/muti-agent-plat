import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPhase6ReleasePreflight,
  parseTraceabilitySummary
} from '../apps/server/src/common/phase-6-release-admission.ts';

export { buildPhase6ReleasePreflight, parseTraceabilitySummary };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const traceabilityPath = resolve(root, 'docs/quality/main-agent-collaboration-phase-6-traceability-matrix-v1.md');
const postgresEvidencePath = resolve(root, '.cache/agent-cluster/phase-6/postgres-migration-evidence.json');

async function main() {
  const traceability = await readFile(traceabilityPath, 'utf8');
  const postgresEvidence = existsSync(postgresEvidencePath)
    ? JSON.parse(await readFile(postgresEvidencePath, 'utf8'))
    : undefined;
  const report = buildPhase6ReleasePreflight({ traceability, postgresEvidence });
  console.log(JSON.stringify(report, null, 2));
  if (report.result !== 'ready') process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
