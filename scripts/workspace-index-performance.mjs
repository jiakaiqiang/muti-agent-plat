import { spawnSync } from 'node:child_process';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is required to run the workspace performance suite.');

function run(args) {
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd: process.cwd(), encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    process.exit(result.status ?? 1);
  }
  const reportLine = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).findLast((line) => line.startsWith('{'));
  if (!reportLine) throw new Error(`Performance command did not return JSON: ${args.join(' ')}`);
  return JSON.parse(reportLine);
}

const registration = run(['run', '--silent', 'test:perf:workspace-registration', '-w', '@agent-cluster/local-runtime-cli']);
const sessionCreate = run(['run', '--silent', 'test:perf:workspace-session-create', '-w', '@agent-cluster/server']);
const report = {
  schemaVersion: '1.0',
  suite: 'workspace-index-first',
  generatedAt: new Date().toISOString(),
  registration,
  sessionCreate,
  passed: registration.passed === true && sessionCreate.passed === true
};
process.stdout.write(`${JSON.stringify(report)}\n`);
process.stderr.write(`Workspace index performance suite: ${report.passed ? 'PASS' : 'FAIL'}.\n`);
if (!report.passed) process.exitCode = 1;
