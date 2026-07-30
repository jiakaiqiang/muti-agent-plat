import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const includedExtensions = new Set(['.ts', '.mts', '.cts', '.json']);

export function sourceTreeFingerprint(roots) {
  const hash = createHash('sha256');
  const resolvedRoots = roots.map((root) => resolve(root));
  const files = resolvedRoots.flatMap((root) => collectSourceFiles(root)).sort((left, right) =>
    left.localeCompare(right)
  );
  for (const file of files) {
    const owningRoot = resolvedRoots.find(
      (root) => file === root || file.startsWith(`${root}\\`) || file.startsWith(`${root}/`)
    );
    hash.update(owningRoot ? relative(owningRoot, file).replace(/\\/g, '/') : file);
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function shouldBuildDevServer({ roots, stampPath, outputPath }) {
  const fingerprint = sourceTreeFingerprint(roots);
  if (!existsSync(outputPath)) return { build: true, fingerprint, reason: 'output_missing' };
  try {
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
    if (stamp?.fingerprint === fingerprint) return { build: false, fingerprint, reason: 'source_unchanged' };
  } catch {
    // Missing or invalid stamps require one authoritative rebuild.
  }
  return { build: true, fingerprint, reason: 'source_changed' };
}

export function writeDevBuildStamp(stampPath, fingerprint) {
  mkdirSync(dirname(stampPath), { recursive: true });
  writeFileSync(stampPath, `${JSON.stringify({ fingerprint, builtAt: new Date().toISOString() })}\n`, 'utf8');
}

function collectSourceFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && includedExtensions.has(extensionOf(entry.name))) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files;
}

function extensionOf(fileName) {
  const index = fileName.lastIndexOf('.');
  return index === -1 ? '' : fileName.slice(index).toLowerCase();
}
