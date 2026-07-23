import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const LARGE_FIXTURE_FILE_COUNT = 1000;

export interface LargeFixtureResult {
  totalFiles: number;
  perGroup: Record<string, number>;
}

/**
 * Materialize a deterministic 1000-file fixture used by the O-stage e2e specs.
 * Layout:
 *   generated/  build outputs — should be excluded by index/scan
 *   src/        TypeScript sources — the primary readable surface
 *   rag/        RAG documents — markdown/json chunks
 *   memory/     agent memory snapshots — jsonl
 *   tools/      tool definitions — json manifests
 */
export async function buildLargeWorkspaceFixture(rootPath: string): Promise<LargeFixtureResult> {
  const groups: Array<{ name: string; count: number; write: (dir: string, index: number) => Promise<void> }> = [
    {
      name: 'generated',
      count: 250,
      write: async (dir, i) => {
        await writeFile(join(dir, `module-${i}.js`), `export const m${i} = ${i};\n`);
        await writeFile(join(dir, `module-${i}.d.ts`), `export declare const m${i}: number;\n`);
      }
    },
    {
      name: 'src',
      count: 300,
      write: async (dir, i) => {
        if (i === 0) {
          await writeFile(join(dir, 'main.ts'), "import { unit1 } from './unit-1';\n\nexport function main() { return unit1(); }\n");
          return;
        }
        await writeFile(join(dir, `unit-${i}.ts`), `export function unit${i}() { return ${i}; }\n`);
      }
    },
    {
      name: 'rag',
      count: 150,
      write: async (dir, i) => {
        await writeFile(join(dir, `doc-${i}.md`), `# Doc ${i}\n\nContent for chunk ${i}.\n`);
      }
    },
    {
      name: 'memory',
      count: 150,
      write: async (dir, i) => {
        await writeFile(join(dir, `snapshot-${i}.jsonl`), `{"turn":${i},"role":"user","content":"turn ${i}"}\n`);
      }
    },
    {
      name: 'tools',
      count: 150,
      write: async (dir, i) => {
        await writeFile(join(dir, `tool-${i}.json`), `{"name":"tool-${i}","version":"1.0.0"}\n`);
      }
    }
  ];

  const perGroup: Record<string, number> = {};
  let totalFiles = 0;
  for (const group of groups) {
    const dir = join(rootPath, group.name);
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < group.count; i += 1) {
      await group.write(dir, i);
    }
    // Some groups write 2 files per iteration (generated .js + .d.ts).
    const filesInGroup = group.name === 'generated' ? group.count * 2 : group.count;
    perGroup[group.name] = filesInGroup;
    totalFiles += filesInGroup;
  }

  return { totalFiles, perGroup };
}
