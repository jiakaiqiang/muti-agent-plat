import test from 'node:test';
import assert from 'node:assert/strict';
import { truncateContentForEvidence } from './evidence-truncation.js';

test('returns content as-is when under budget', () => {
  const result = truncateContentForEvidence('src/a.ts', 'export const a = 1\n', 4096);
  assert.equal(result.truncated, false);
  assert.equal(result.content, 'export const a = 1\n');
  assert.equal(result.truncatedHint, undefined);
});

test('truncates TS via default slice strategy when over budget and no query', () => {
  const big = 'x'.repeat(20_000);
  const result = truncateContentForEvidence('src/big.ts', big, 8_000);
  assert.equal(result.truncated, true);
  assert.ok(result.content.length <= 8_000);
  assert.ok(result.truncatedHint);
  assert.equal(result.truncatedHint.strategy, 'slice');
  assert.equal(result.truncatedHint.originalBytes, 20_000);
  assert.ok(result.truncatedHint.keptBytes <= 8_000);
});

test('truncates JS via slice strategy when no query hint', () => {
  const big = '// js\n'.repeat(5000);
  const result = truncateContentForEvidence('lib/util.js', big, 4_000);
  assert.equal(result.truncated, true);
  assert.equal(result.truncatedHint?.strategy, 'slice');
});

test('truncates Markdown via slice strategy in T08 baseline', () => {
  const big = '# heading\n'.repeat(2000);
  const result = truncateContentForEvidence('docs/big.md', big, 1_000);
  assert.equal(result.truncated, true);
  assert.ok(result.content.length <= 1_000);
  assert.equal(result.truncatedHint?.strategy, 'slice');
});

test('truncates plain text via slice strategy', () => {
  const big = 'line\n'.repeat(5000);
  const result = truncateContentForEvidence('notes.txt', big, 500);
  assert.equal(result.truncated, true);
  assert.ok(result.content.length <= 500);
  assert.equal(result.truncatedHint?.strategy, 'slice');
});

test('truncates unknown/binary extensions via slice fallback', () => {
  const big = 'A'.repeat(10_000);
  const result = truncateContentForEvidence('assets/data.bin', big, 256);
  assert.equal(result.truncated, true);
  assert.ok(result.content.length <= 256);
  assert.equal(result.truncatedHint?.strategy, 'slice');
});

test('zero or negative budget falls back to empty content with truncatedHint', () => {
  const result = truncateContentForEvidence('src/a.ts', 'hello', 0);
  assert.equal(result.truncated, true);
  assert.equal(result.content, '');
  assert.equal(result.truncatedHint?.keptBytes, 0);
});

test('handles empty content without truncation', () => {
  const result = truncateContentForEvidence('src/a.ts', '', 4096);
  assert.equal(result.truncated, false);
  assert.equal(result.content, '');
  assert.equal(result.truncatedHint, undefined);
});

// --- T09: ts-symbol-window ---

const sampleTs = (() => {
  const filler = (label: string, lines: number) =>
    Array.from({ length: lines }, (_, i) => `  // ${label} filler ${i}`).join('\n');

  return [
    `import { Injectable } from '@nestjs/common';`,
    `import type { SessionDetail } from '@agent-cluster/shared';`,
    ``,
    `const TRIVIAL_CONST = 'one';`,
    ``,
    `// some unrelated helper`,
    `export function helperOne() {`,
    `${filler('helperOne', 200)}`,
    `  return 1;`,
    `}`,
    ``,
    `// the symbol we are looking for`,
    `export class SessionService {`,
    `  constructor(private readonly snapshot: SessionDetail) {}`,
    `${filler('SessionService body', 60)}`,
    `  serve() { return this.snapshot; }`,
    `}`,
    ``,
    `// another unrelated chunk after`,
    `export function helperTwo() {`,
    `${filler('helperTwo', 200)}`,
    `  return 2;`,
    `}`
  ].join('\n');
})();

test('ts-symbol-window: query match keeps the matching symbol body within budget', () => {
  const result = truncateContentForEvidence('src/session.service.ts', sampleTs, 4_000, {
    query: 'SessionService'
  });
  assert.equal(result.truncated, true);
  assert.ok(result.truncatedHint);
  assert.equal(result.truncatedHint.strategy, 'ts-symbol-window');
  assert.ok(result.content.includes('SessionService'), 'symbol must be present in output');
  assert.ok(result.content.includes("import { Injectable }"), 'imports should be preserved at top');
  assert.ok(result.truncatedHint.keptBytes <= 4_000);
});

test('ts-symbol-window: query that does not match falls back to slice', () => {
  const big = 'export const a = 1\n'.repeat(2_000);
  const result = truncateContentForEvidence('src/no-match.ts', big, 2_000, {
    query: 'NotPresentSymbol__xyz123'
  });
  assert.equal(result.truncated, true);
  assert.equal(result.truncatedHint?.strategy, 'slice');
});

test('ts-symbol-window: applies to .tsx and .vue too', () => {
  const result = truncateContentForEvidence('src/App.tsx', sampleTs, 4_000, {
    query: 'SessionService'
  });
  assert.equal(result.truncatedHint?.strategy, 'ts-symbol-window');
  const vueResult = truncateContentForEvidence('src/App.vue', sampleTs, 4_000, {
    query: 'SessionService'
  });
  assert.equal(vueResult.truncatedHint?.strategy, 'ts-symbol-window');
});

test('ts-symbol-window: leaves untouched when content already fits', () => {
  const small = `export const tiny = 1;\n`;
  const result = truncateContentForEvidence('src/tiny.ts', small, 4_000, { query: 'tiny' });
  assert.equal(result.truncated, false);
  assert.equal(result.truncatedHint, undefined);
});

// --- T10: md-section-window ---

const sampleMd = [
  '# Project README',
  '',
  'Intro paragraph that lives above any H2.',
  '',
  '## Setup',
  'Run npm install and start the dev server.',
  '- step 1',
  '- step 2',
  '',
  '## Architecture',
  'Layered architecture with NestJS at the core and Pinia on the frontend.',
  'There is a dedicated SessionService that orchestrates the runtime calls.',
  '',
  '## Testing',
  'Use vitest for the frontend and node:test for the server.',
  '',
  '## Deployment',
  'CI publishes via the deploy.yml workflow.',
  'Watch the Grafana dashboard during cutover.',
  ''
].join('\n');

test('md-section-window: keeps top region + best-fit sections within budget', () => {
  // Budget intentionally smaller than the whole doc but big enough for the
  // top region plus a couple of sections.
  const result = truncateContentForEvidence('docs/README.md', sampleMd, 220);
  assert.equal(result.truncated, true);
  assert.ok(result.truncatedHint);
  assert.equal(result.truncatedHint.strategy, 'md-section-window');
  assert.ok(result.content.includes('# Project README'), 'top region (title) must survive');
  assert.ok(result.truncatedHint.keptBytes <= 220);
  assert.ok(
    Array.isArray(result.truncatedHint.keptSections) && result.truncatedHint.keptSections.length >= 1,
    'keptSections should be populated'
  );
});

test('md-section-window: prefers sections matching the query', () => {
  const result = truncateContentForEvidence('docs/README.md', sampleMd, 300, {
    query: 'SessionService'
  });
  assert.equal(result.truncatedHint?.strategy, 'md-section-window');
  assert.ok(result.content.includes('SessionService'));
  assert.ok(
    result.truncatedHint?.keptSections?.includes('Architecture'),
    `expected "Architecture" in kept sections, got ${JSON.stringify(result.truncatedHint?.keptSections)}`
  );
});

test('md-section-window: records droppedSections', () => {
  const result = truncateContentForEvidence('docs/README.md', sampleMd, 200);
  const hint = result.truncatedHint;
  assert.ok(hint?.droppedSections, 'droppedSections should be present');
  const allSections = ['Setup', 'Architecture', 'Testing', 'Deployment'];
  const partitioned = new Set([...(hint?.keptSections ?? []), ...(hint?.droppedSections ?? [])]);
  for (const section of allSections) {
    assert.ok(partitioned.has(section), `section ${section} should be accounted for`);
  }
});

test('md-section-window: applies to .markdown extension too', () => {
  const result = truncateContentForEvidence('docs/README.markdown', sampleMd, 220);
  assert.equal(result.truncatedHint?.strategy, 'md-section-window');
});

test('md-section-window: no H2 sections falls back to slice', () => {
  const flatMd = '# Only Title\n\nThis doc has no H2 sections at all.\n'.repeat(80);
  const result = truncateContentForEvidence('docs/flat.md', flatMd, 200);
  assert.equal(result.truncatedHint?.strategy, 'slice');
});

