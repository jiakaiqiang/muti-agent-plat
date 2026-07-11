import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { baselineMarkdown, buildWatchdogBaseline, collectWatchdogSamples } from './watchdog-baseline.mjs';

const inputPath = process.env.WATCHDOG_SAMPLE_REPORT_PATH ?? join(
  process.cwd(),
  '.cache',
  'agent-cluster',
  'real-cli-acceptance-status.json'
);
const outputPath = process.env.WATCHDOG_BASELINE_OUTPUT_PATH ?? join(
  process.cwd(),
  '.cache',
  'agent-cluster',
  'watchdog-baseline-report.json'
);
const markdownPath = process.env.WATCHDOG_BASELINE_MARKDOWN_PATH ?? join(
  process.cwd(),
  '.cache',
  'agent-cluster',
  'watchdog-baseline-report.md'
);
const minSamples = Number(process.env.WATCHDOG_MIN_SAMPLES ?? 20);
const runtimeType = process.env.WATCHDOG_RUNTIME?.trim() || undefined;

const source = JSON.parse(await readFile(inputPath, 'utf8'));
const samples = collectWatchdogSamples(source);
const baseline = buildWatchdogBaseline(samples, { minSamples, runtimeType });
await mkdir(dirname(outputPath), { recursive: true });
await mkdir(dirname(markdownPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
await writeFile(markdownPath, baselineMarkdown(baseline), 'utf8');
console.log(JSON.stringify({ ok: true, inputPath, outputPath, markdownPath, baseline }, null, 2));
