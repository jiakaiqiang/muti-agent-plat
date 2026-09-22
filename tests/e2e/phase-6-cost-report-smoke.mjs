import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildLongSessionFixture, evaluateLongSession } from '../../scripts/phase-6-long-session-fixture.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const reportPath = resolve(root, 'docs/quality/main-agent-collaboration-phase-6-cost-report-v1.md');
const report = await readFile(reportPath, 'utf8');
const fixture = buildLongSessionFixture();
const result = evaluateLongSession(fixture);
assert.match(report, /priceVersion/);
assert.match(report, /AGENT_CLUSTER_RUNTIME_PRICING_JSON/);
assert.match(report, /costBasis=estimated/);
assert.match(report, /unknown/);
assert.match(report, new RegExp(`${result.workItemCount} `));
assert.match(report, /冷/);
assert.match(report, /热/);
assert.doesNotMatch(report, /(authorization:|bearer\s+[a-z0-9]|api[_-]?key|password|secret|BEGIN [A-Z ]*PRIVATE KEY|sk-[a-z0-9])/i);
for (const item of fixture.messages) {
  assert.equal(report.includes(item.content), false, `report must not contain full message body: ${item.id}`);
}
console.log('phase 6 cost report smoke passed: report keeps unknown price/usage explicit');
