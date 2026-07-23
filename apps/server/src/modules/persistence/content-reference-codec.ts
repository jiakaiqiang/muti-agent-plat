import { Injectable } from '@nestjs/common';
import { LocalContentStore, type StoredContent } from './local-content-store.js';

export type ContentReferenceMarker = {
  $contentRef: string;
  $sha256: string;
  $sizeBytes: number;
  $mediaType: string;
};

export type ExternalizedValue<T> = {
  value: T;
  contents: StoredContent[];
};

const FILE_CONTAINER_KEYS = new Set([
  'fileChanges',
  'changes',
  'files',
  'selectedEvidenceContents',
  'platformProjections',
  'runtimeProposals',
  'workspaceChangeSet',
  'workspaceSnapshot',
  'report'
]);

const ALWAYS_EXTERNALIZED_KEYS = new Set(['stdout', 'stderr']);
const LARGE_OUTPUT_KEYS = new Set(['rawOutput', 'rawResult', 'diagnostics', 'output']);

@Injectable()
export class ContentReferenceCodec {
  private readonly largeOutputThreshold: number;

  constructor(private readonly store: LocalContentStore) {
    this.largeOutputThreshold = positiveInteger(process.env.AGENT_CLUSTER_INLINE_OUTPUT_MAX_BYTES, 65_536);
  }

  externalize<T>(input: T): ExternalizedValue<T> {
    const contents = new Map<string, StoredContent>();
    const value = this.visitExternalize(input, [], contents) as T;
    return { value, contents: [...contents.values()] };
  }

  hydrate<T>(input: T): T {
    return this.visitHydrate(input) as T;
  }

  private visitExternalize(value: unknown, path: string[], contents: Map<string, StoredContent>): unknown {
    if (Array.isArray(value)) return value.map((item) => this.visitExternalize(item, path, contents));
    if (!isRecord(value) || isContentReferenceMarker(value)) return value;

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && this.shouldExternalize(value, key, item, path)) {
        const stored = this.store.put(item, this.mediaType(value), this.originalName(value));
        contents.set(stored.contentRef, stored);
        result[key] = marker(stored);
      } else {
        result[key] = this.visitExternalize(item, [...path, key], contents);
      }
    }
    return result;
  }

  private visitHydrate(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.visitHydrate(item));
    if (isContentReferenceMarker(value)) return this.store.read(value.$contentRef).toString('utf8');
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.visitHydrate(item)]));
  }

  private shouldExternalize(object: Record<string, unknown>, key: string, value: string, path: string[]): boolean {
    if (ALWAYS_EXTERNALIZED_KEYS.has(key)) return true;
    if (LARGE_OUTPUT_KEYS.has(key) && Buffer.byteLength(value) > this.largeOutputThreshold) return true;
    if (key !== 'content' && key !== 'previousContent') return false;

    const hasFileIdentity = ['path', 'filePath', 'relativePath', 'fromPath', 'toPath', 'suggestedPath'].some(
      (field) => typeof object[field] === 'string'
    );
    const workspaceEvidence = object.source === 'workspace_file';
    const insideFileContainer = path.some((segment) => FILE_CONTAINER_KEYS.has(segment));
    return hasFileIdentity || workspaceEvidence || insideFileContainer;
  }

  private mediaType(object: Record<string, unknown>): string {
    if (typeof object.mediaType === 'string') return object.mediaType;
    if (object.encoding === 'utf-8' || object.format === 'markdown') return 'text/plain; charset=utf-8';
    return 'text/plain; charset=utf-8';
  }

  private originalName(object: Record<string, unknown>): string | undefined {
    for (const key of ['path', 'filePath', 'relativePath', 'suggestedPath', 'title']) {
      if (typeof object[key] === 'string') return object[key];
    }
    return undefined;
  }
}
function marker(stored: StoredContent): ContentReferenceMarker {
  return {
    $contentRef: stored.contentRef,
    $sha256: stored.sha256,
    $sizeBytes: stored.sizeBytes,
    $mediaType: stored.mediaType
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isContentReferenceMarker(value: unknown): value is ContentReferenceMarker {
  return (
    isRecord(value) &&
    typeof value.$contentRef === 'string' &&
    typeof value.$sha256 === 'string' &&
    typeof value.$sizeBytes === 'number' &&
    typeof value.$mediaType === 'string'
  );
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
