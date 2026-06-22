// PoC smoke for the workspace tool layer (Pull mode, executing-pull-context-design-v1).
// Validates the security boundary of WorkspaceToolsService directly, without
// driving a real LLM. The tool-loop runtime integration (generic_llm tool_use
// wiring) is left for a follow-up once a test LLM endpoint is available.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildServer } from './smoke-server.mjs';

await buildServer();

async function loadService() {
  // After buildServer the compiled JS lives under apps/server/dist/...
  // Mirror the source layout: apps/server/dist/apps/server/src/modules/runtimes/workspace-tools.service.js
  const url = pathToFileURL(
    join(
      process.cwd(),
      'apps/server/dist/apps/server/src/modules/runtimes/workspace-tools.service.js'
    )
  ).href;
  const mod = await import(url);
  return new mod.WorkspaceToolsService();
}

function assertOk(condition, message) {
  if (!condition) {
    console.error(`ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

const root = mkdtempSync(join(tmpdir(), 'workspace-tools-poc-'));
let failed = false;

try {
  // Lay out fixture files.
  mkdirSync(join(root, 'apps/server/src/common'), { recursive: true });
  writeFileSync(join(root, 'apps/server/src/common/main.ts'), 'export const hello = "world";\n');
  writeFileSync(join(root, 'README.md'), '# Test repo\nUse Pull-mode workspace tools.\n');
  writeFileSync(join(root, '.env'), 'DATABASE_URL=postgres://secret');
  writeFileSync(join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  mkdirSync(join(root, 'big'), { recursive: true });
  const big = 'X'.repeat(40 * 1024); // 40KB > 32KB cap
  writeFileSync(join(root, 'big/large.txt'), big);

  // Place a file outside root and symlink it in (only meaningful on POSIX).
  const outside = mkdtempSync(join(tmpdir(), 'workspace-tools-poc-outside-'));
  writeFileSync(join(outside, 'leak.txt'), 'should-not-be-readable');
  let symlinkedReady = false;
  try {
    symlinkSync(join(outside, 'leak.txt'), join(root, 'escape.txt'));
    symlinkedReady = true;
  } catch (error) {
    // Windows non-admin can't create symlinks; skip that assertion silently.
    console.warn(`[skip] symlink creation not supported in this env: ${error?.code ?? error}`);
  }

  const service = await loadService();

  // 1. Happy path: read a normal text file.
  const ok1 = await service.readFile(root, { path: 'README.md' });
  assertOk(ok1.ok === true, `case1.ok expected true, got ${JSON.stringify(ok1)}`);
  assertOk(ok1.output.includes('Pull-mode workspace tools'), 'case1.output should include README content');
  assertOk(ok1.truncated === false, 'case1.truncated should be false');

  // 2. Nested path with extension whitelist hit.
  const ok2 = await service.readFile(root, { path: 'apps/server/src/common/main.ts' });
  assertOk(ok2.ok === true, `case2 expected ok, got ${ok2.errorCode}`);
  assertOk(ok2.output.includes('hello'), 'case2 should contain "hello"');

  // 3. Sensitive file (.env) refused.
  const ok3 = await service.readFile(root, { path: '.env' });
  assertOk(ok3.ok === false && ok3.errorCode === 'SENSITIVE_PATH', `case3 must refuse .env, got ${JSON.stringify(ok3)}`);

  // 4. Path traversal refused.
  const ok4 = await service.readFile(root, { path: '../outside.txt' });
  assertOk(ok4.ok === false && ok4.errorCode === 'PATH_TRAVERSAL', `case4 must refuse traversal, got ${JSON.stringify(ok4)}`);

  // 5. Backslash path normalized then refused if it traverses.
  const ok5 = await service.readFile(root, { path: '..\\outside.txt' });
  assertOk(ok5.ok === false && ok5.errorCode === 'PATH_TRAVERSAL', `case5 must refuse Windows-style traversal, got ${JSON.stringify(ok5)}`);

  // 6. Binary file refused (not in text whitelist).
  const ok6 = await service.readFile(root, { path: 'image.png' });
  assertOk(ok6.ok === false && ok6.errorCode === 'NON_TEXT_FILE', `case6 must refuse binary, got ${JSON.stringify(ok6)}`);

  // 7. Truncation flag for oversized file.
  const ok7 = await service.readFile(root, { path: 'big/large.txt' });
  assertOk(ok7.ok === true, `case7 expected ok, got ${ok7.errorCode}`);
  assertOk(ok7.truncated === true, 'case7 must flag truncated for >32KB file');
  assertOk(ok7.output.length <= 32 * 1024, 'case7 output must be capped to 32KB');

  // 8. Missing file returns NOT_FOUND.
  const ok8 = await service.readFile(root, { path: 'does-not-exist.md' });
  assertOk(ok8.ok === false && ok8.errorCode === 'NOT_FOUND', `case8 must return NOT_FOUND, got ${JSON.stringify(ok8)}`);

  // 9. Empty/missing input handled.
  const ok9 = await service.readFile(root, {});
  assertOk(ok9.ok === false && ok9.errorCode === 'INVALID_INPUT', `case9 must reject missing path, got ${JSON.stringify(ok9)}`);

  // 10. Symlink escape is blocked (only when symlink was created).
  if (symlinkedReady) {
    const ok10 = await service.readFile(root, { path: 'escape.txt' });
    assertOk(
      ok10.ok === false && ok10.errorCode === 'PATH_TRAVERSAL',
      `case10 must block symlink escaping root, got ${JSON.stringify(ok10)}`
    );
  }

  // 11. Empty root path rejected gracefully.
  const ok11 = await service.readFile('', { path: 'README.md' });
  assertOk(ok11.ok === false && ok11.errorCode === 'NO_ROOT', `case11 must report NO_ROOT, got ${JSON.stringify(ok11)}`);

  // 12. Deep credential path inside .ssh subdirectory blocked.
  mkdirSync(join(root, '.ssh'), { recursive: true });
  writeFileSync(join(root, '.ssh/id_rsa'), 'fake-key');
  const ok12 = await service.readFile(root, { path: '.ssh/id_rsa' });
  assertOk(
    ok12.ok === false && ok12.errorCode === 'SENSITIVE_PATH',
    `case12 must refuse anything under .ssh/, got ${JSON.stringify(ok12)}`
  );

  console.log('workspace tools pull smoke ok');
} catch (error) {
  failed = true;
  console.error(error?.stack ?? error);
} finally {
  rmSync(root, { recursive: true, force: true });
  if (failed) process.exit(1);
}
