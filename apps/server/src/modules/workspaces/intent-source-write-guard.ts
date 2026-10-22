import { lstat, open, readdir } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import type { WorkspaceChangeSet } from '@agent-cluster/shared';
import ts from 'typescript';
import { assertWorkspaceWriteAllowed } from './workspace-sensitive-guard.js';
import { assertWorkspacePathWithinRoot } from './workspace-symlink-guard.js';

export type IntentSourceWritePolicy = {
  rootPath: string;
  files: readonly { path: string }[];
  prohibitions: readonly ('no_schema_change')[];
};

export const INTENT_SOURCE_WRITE_LIMITS = Object.freeze({ files: 32, fileBytes: 256 * 1024, totalBytes: 1024 * 1024 });

function reject(reason: string): never {
  throw new Error(`INTENT_SOURCE_CHANGESET_REJECTED: ${reason}`);
}

/** The caller must hold its authority/apply lock and recheck this gate on the final merged ChangeSet. */
export async function assertIntentSourceChangeSet(policy: IntentSourceWritePolicy, changeSet: WorkspaceChangeSet): Promise<void> {
  try {
    if (!policy || typeof policy.rootPath !== 'string' || !isAbsolute(policy.rootPath) ||
        !Array.isArray(policy.files) || !policy.files.length || policy.files.length > INTENT_SOURCE_WRITE_LIMITS.files ||
        !Array.isArray(policy.prohibitions) || policy.prohibitions.some(item => item !== 'no_schema_change')) reject('invalid policy');
    if (!changeSet || !Array.isArray(changeSet.changes) || !changeSet.changes.length ||
        changeSet.changes.length > INTENT_SOURCE_WRITE_LIMITS.files) reject('change count limit');
    const manifest = new Set<string>(), aliases = new Set<string>();
    for (const file of policy.files) {
      assertExactRelativePath(file?.path);
      const alias = file.path.toLowerCase();
      if (aliases.has(alias)) reject('duplicate or case-aliased manifest path');
      manifest.add(file.path); aliases.add(alias);
    }
    const root = resolve(policy.rootPath);
    // The containment guard alone permits links pointing inside the root. Candidate writes forbid all links,
    // including a junction in the root's own ancestors, rather than trusting its current destination.
    for (let ancestor = root; ;) {
      const metadata = await lstat(ancestor);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) reject('linked or non-directory root ancestor');
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    assertWorkspaceWriteAllowed(changeSet.changes);
    const seen = new Set<string>();
    let total = 0;
    for (const change of changeSet.changes) {
      if (change.operation !== 'update' || change.encoding !== 'utf-8') reject('only UTF-8 update is supported');
      assertExactRelativePath(change.path);
      if (!manifest.has(change.path)) reject('file is outside the exact authorized manifest');
      const alias = change.path.toLowerCase();
      if (seen.has(alias)) reject('duplicate update path');
      seen.add(alias);
      assertUnicodeText(change.content);
      const proposedBytes = Buffer.byteLength(change.content, 'utf8');
      total += proposedBytes;
      if (proposedBytes > INTENT_SOURCE_WRITE_LIMITS.fileBytes || total > INTENT_SOURCE_WRITE_LIMITS.totalBytes) reject('candidate byte limit');
      await assertWorkspacePathWithinRoot(root, change.path);
      let target = root;
      const segments = change.path.split('/');
      for (const [index, segment] of segments.entries()) {
        // Exact directory entries reject a spelling alias even on a case-insensitive filesystem.
        if (!(await readdir(target)).includes(segment)) reject('missing file or case alias');
        target = join(target, segment);
        const metadata = await lstat(target);
        if (metadata.isSymbolicLink()) reject('linked path is not supported');
        if (index < segments.length - 1 && !metadata.isDirectory()) reject('non-directory ancestor');
      }
      const before = await lstat(target);
      if (!before.isFile() || before.nlink !== 1 || before.size > INTENT_SOURCE_WRITE_LIMITS.fileBytes) reject('target is not a bounded unlinked regular file');
      const handle = await open(target, 'r');
      let bytes: Buffer;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) reject('file changed before bounded read');
        const buffer = Buffer.alloc(INTENT_SOURCE_WRITE_LIMITS.fileBytes + 1);
        let length = 0;
        while (length < buffer.length) {
          const result = await handle.read(buffer, length, buffer.length - length, length);
          if (!result.bytesRead) break;
          length += result.bytesRead;
        }
        bytes = buffer.subarray(0, length);
      } finally { await handle.close(); }
      const after = await lstat(target);
      if (after.isSymbolicLink() || !after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino ||
          after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== before.size) reject('file changed during validation');
      const current = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      assertUnicodeText(current);
      // expectedHash is intentionally left to provider validation/merge; comparing it here would defeat three-way merge.
      if (policy.prohibitions.includes('no_schema_change')) assertOnlyPureGuardInsertion(change.path, current, change.content);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('INTENT_SOURCE_CHANGESET_REJECTED:')) throw error;
    reject(error instanceof Error ? error.message : 'unverifiable candidate');
  }
}

function assertExactRelativePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path !== path.normalize('NFC') ||
      /[\\:\x00-\x1f<>"|?*]/u.test(path)) reject('invalid relative file path');
  for (const part of path.split('/')) {
    if (!part || part === '.' || part === '..' || part.trim() !== part || part.endsWith('.') ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)) reject('non-canonical relative file path');
  }
}

function assertUnicodeText(content: unknown): asserts content is string {
  if (typeof content !== 'string' || content.includes('\0')) reject('text is not NUL-free UTF-8');
  // Buffer.from silently replaces unmatched UTF-16 surrogates. Refuse them before encoding.
  for (let i = 0; i < content.length; i += 1) {
    const unit = content.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = content.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) reject('unpaired UTF-16 surrogate');
    } else if (unit >= 0xdc00 && unit <= 0xdfff) reject('unpaired UTF-16 surrogate');
  }
}

/** A sufficient proof for one deliberately tiny edit language, not a SQL/ORM blacklist. */
function assertOnlyPureGuardInsertion(path: string, current: string, proposed: string): void {
  if (!['.ts', '.js'].includes(extname(path))) reject('schema proof only supports ordinary TS/JS functions');
  const kind = extname(path) === '.js' ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const before = ts.createSourceFile(path, current, ts.ScriptTarget.Latest, true, kind);
  const after = ts.createSourceFile(path, proposed, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = (source: ts.SourceFile) => (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics(before).length || diagnostics(after).length || before.statements.length !== after.statements.length) reject('schema proof parse/top-level mismatch');
  if (outsideFunctionBodies(before) !== outsideFunctionBodies(after)) reject('schema proof changed text outside function bodies');
  for (let i = 0; i < before.statements.length; i += 1) {
    const oldStatement = before.statements[i], newStatement = after.statements[i];
    if (ts.isImportDeclaration(oldStatement) && ts.isImportDeclaration(newStatement)) {
      if (oldStatement.getText(before) !== newStatement.getText(after)) reject('schema proof changed import');
      continue;
    }
    if (!isOrdinaryFunction(oldStatement) || !isOrdinaryFunction(newStatement)) reject('schema proof unsupported top-level syntax');
    const oldFunction = oldStatement, newFunction = newStatement;
    const signature = (node: ts.FunctionDeclaration, source: ts.SourceFile) => source.text.slice(node.getStart(source), node.body!.getStart(source));
    if (signature(oldFunction, before) !== signature(newFunction, after)) reject('schema proof changed function signature');
    const parameters = new Set(oldFunction.parameters.map(parameter => (parameter.name as ts.Identifier).text));
    let oldIndex = 0;
    for (const statement of newFunction.body!.statements) {
      const old = oldFunction.body!.statements[oldIndex];
      if (old && old.getText(before) === statement.getText(after)) { oldIndex += 1; continue; }
      // Only front-of-body guards are admitted. That avoids locals, scopes or earlier statement effects
      // influencing the proof, and leaves every original statement in exactly its original order.
      if (oldIndex !== 0 || isDirective(old) || !isPureGuard(statement, parameters)) reject('schema proof is not a pure guard insertion');
    }
    if (oldIndex !== oldFunction.body!.statements.length) reject('schema proof removed an existing statement');
  }
}

function outsideFunctionBodies(source: ts.SourceFile): string {
  let cursor = 0, result = '';
  for (const statement of source.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.body) continue;
    result += source.text.slice(cursor, statement.body.getStart(source)) + '{<unchanged-body-slot>}';
    cursor = statement.body.end;
  }
  return result + source.text.slice(cursor);
}

function isDirective(statement: ts.Statement | undefined): boolean {
  return !!statement && ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression);
}

function isOrdinaryFunction(statement: ts.Statement): statement is ts.FunctionDeclaration {
  return ts.isFunctionDeclaration(statement) && !!statement.name && !!statement.body && !statement.asteriskToken &&
    !statement.typeParameters?.length && !statement.modifiers?.some(modifier => ![ts.SyntaxKind.ExportKeyword, ts.SyntaxKind.DefaultKeyword].includes(modifier.kind)) &&
    statement.parameters.every(parameter => ts.isIdentifier(parameter.name) && !parameter.dotDotDotToken && !parameter.initializer && !parameter.modifiers?.length);
}

function isPureGuard(statement: ts.Statement, parameters: ReadonlySet<string>): boolean {
  if (!ts.isIfStatement(statement) || statement.elseStatement || !isPureCondition(statement.expression, parameters)) return false;
  const branch = ts.isBlock(statement.thenStatement) ? statement.thenStatement.statements : [statement.thenStatement];
  return branch.length === 1 && ts.isReturnStatement(branch[0]) && !!branch[0].expression && isPureLiteral(branch[0].expression);
}

function isPureCondition(node: ts.Expression, parameters: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(node)) return parameters.has(node.text);
  if (isPrimitiveLiteral(node)) return true;
  if (ts.isParenthesizedExpression(node)) return isPureCondition(node.expression, parameters);
  if (ts.isPrefixUnaryExpression(node)) return node.operator === ts.SyntaxKind.ExclamationToken && isPureCondition(node.operand, parameters);
  if (ts.isTypeOfExpression(node)) return ts.isIdentifier(node.expression) && parameters.has(node.expression.text);
  if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
    return isPureCondition(node.left, parameters) && isPureCondition(node.right, parameters);
  }
  return false;
}

function isPrimitiveLiteral(node: ts.Expression): boolean {
  return ts.isStringLiteral(node) || ts.isNumericLiteral(node) ||
    [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind);
}

function isPureLiteral(node: ts.Expression): boolean {
  if (isPrimitiveLiteral(node)) return true;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return true;
  if (!ts.isObjectLiteralExpression(node)) return false;
  return node.properties.every(property => ts.isPropertyAssignment(property) &&
    (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)) &&
    property.name.text !== '__proto__' && isPureLiteral(property.initializer));
}
