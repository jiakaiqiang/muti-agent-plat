import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is required; run this script through npm.');

const commands = [
  ['test:e2e:client-presentation', 'Web/Desktop shared-state and independent-style presentation'],
  ['test:e2e:desktop-render', 'Desktop renderer build and render smoke'],
  ['test:e2e:workflow-managed-execution', 'Workflow execution state chain'],
  ['test:e2e:rework-loop', 'Quality rejection and rework loop'],
  ['test:e2e:phase-5-execution-change', 'Change queue and stop/delete fencing']
];

function run(script) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [npmCli, 'run', script], { cwd: root, stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolveRun({ script, status: 'passed' }) : resolveRun({ script, status: 'failed', exitCode: code }));
  });
}

const results = [];
for (const [script] of commands) results.push(await run(script));
console.log(JSON.stringify({ results, allPassed: results.every((item) => item.status === 'passed') }, null, 2));
if (results.some((item) => item.status === 'failed')) process.exitCode = 1;
