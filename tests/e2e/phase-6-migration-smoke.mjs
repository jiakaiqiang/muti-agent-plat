import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'npm_execpath is required');
const child = spawn(process.execPath, [npmCli, 'run', 'phase-6:migration-drill'], { cwd: root, stdio: 'inherit', env: process.env });
const exitCode = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
assert.equal(exitCode, 0, `migration drill failed with ${exitCode}`);
