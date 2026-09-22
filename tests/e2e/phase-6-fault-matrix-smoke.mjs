import assert from 'node:assert/strict';
import { runFaultMatrix } from '../../scripts/phase-6-fault-matrix.mjs';

const report = await runFaultMatrix();
assert.equal(report.allDeterministicChecksPassed, true);
assert.equal(report.backend, 'file');
assert.equal(report.scenarios.length, 6);
assert.ok(report.scenarios.every((scenario) => scenario.status === 'passed'));
assert.ok(report.scenarios.every((scenario) => scenario.actual === scenario.expected));
assert.ok(report.scenarios.every((scenario) => scenario.component !== 'scenario-runner'));
assert.ok(report.scenarios.every((scenario) => Object.keys(scenario.observed ?? {}).length >= 3));

const byId = Object.fromEntries(report.scenarios.map((scenario) => [scenario.id, scenario]));
assert.deepEqual(byId['duplicate-submit'].observed.submitStatuses, ['duplicate', 'submitted']);
assert.equal(byId['duplicate-submit'].observed.persistedRequestCount, 1);
assert.equal(byId['out-of-order-completion'].observed.replayStatus, 'idempotent');
assert.equal(byId['out-of-order-completion'].observed.staleTransitionCode, 'DELEGATION_INVALID_TRANSITION');
assert.equal(byId['crash-after-reserve'].observed.duplicateCompletionStatus, 'idempotent');
assert.equal(byId['crash-after-reserve'].observed.authoritativeRunPreserved, true);
assert.equal(byId['delete-before-callback'].observed.callbackCode, 'SESSION_ADMISSION_CLOSED');
assert.equal(byId['delete-before-callback'].observed.resultPersisted, false);
assert.equal(byId['budget-exhausted'].observed.secondReservationStatus, 'insufficient');
assert.equal(byId['budget-exhausted'].observed.persistedReservedTokens, 700);
assert.equal(byId['cache-backfill-after-delete'].observed.backfillAccepted, false);
assert.equal(byId['cache-backfill-after-delete'].observed.rejectedBackfills, 1);
assert.match(report.postgres, /not executed|executed/);

console.log(
  `phase 6 fault matrix smoke passed: ${report.scenarios.length} real component scenarios; backend=${report.backend}; PostgreSQL=${report.postgres}`
);
