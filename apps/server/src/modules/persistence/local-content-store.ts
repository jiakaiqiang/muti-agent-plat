import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export type LocalContentStoreOptions = {
  rootDir?: string;
};

export type StoredContent = {
  contentRef: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  storagePath: string;
};

/**
 * 保存不适合直接进入 PostgreSQL 的不可变正文。数据库只记录返回的 contentRef 和哈希。
 */
@Injectable()
export class LocalContentStore {
  private readonly rootDir: string;

  constructor(options: LocalContentStoreOptions = {}) {
    const environmentRoot = process.env.AGENT_CLUSTER_ENV_DIR?.trim();
    const dataDir = process.env.AGENT_CLUSTER_DATA_DIR ?? join(environmentRoot || process.cwd(), '.cache', 'agent-cluster');
    this.rootDir = resolve(options.rootDir ?? process.env.AGENT_CLUSTER_CONTENT_DIR ?? join(dataDir, 'content-store'));
  }

  rootPath(): string {
    return this.rootDir;
  }

  put(content: string | Uint8Array, mediaType = 'application/octet-stream', originalName?: string): StoredContent {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const storagePath = this.storagePathForHash(sha256);
    const absolutePath = resolve(this.rootDir, storagePath);
    mkdirSync(dirname(absolutePath), { recursive: true });

    if (!existsSync(absolutePath)) {
      const temporaryPath = `${absolutePath}.${process.pid}.${randomUUID()}.tmp`;
      let renamed = false;
      try {
        writeFileSync(temporaryPath, bytes, { flag: 'wx' });
        const descriptor = openSync(temporaryPath, 'r+');
        try {
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        if (existsSync(absolutePath)) {
          unlinkSync(temporaryPath);
        } else {
          renameSync(temporaryPath, absolutePath);
          renamed = true;
        }
      } finally {
        if (!renamed && existsSync(temporaryPath)) {
          try {
            unlinkSync(temporaryPath);
          } catch {
            // 保留原始写入错误，唯一临时文件由后续 GC 清理。
          }
        }
      }
    }

    this.verifyHash(sha256);
    return {
      contentRef: `content:${sha256}`,
      sha256,
      sizeBytes: bytes.byteLength,
      mediaType,
      storagePath: originalName ? `${storagePath}#${encodeURIComponent(originalName)}` : storagePath
    };
  }

  read(contentRef: string): Buffer {
    const sha256 = this.hashFromRef(contentRef);
    const path = resolve(this.rootDir, this.storagePathForHash(sha256));
    if (!this.isWithinRoot(path)) {
      throw new Error('CONTENT_PATH_INVALID: content reference escapes LocalContentStore.');
    }
    if (!existsSync(path)) {
      throw new Error(`CONTENT_UNAVAILABLE: content object does not exist: ${contentRef}`);
    }
    const bytes = readFileSync(path);
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== sha256) {
      throw new Error(`CONTENT_HASH_MISMATCH: expected ${sha256}, actual ${actualHash}.`);
    }
    return bytes;
  }

  verify(contentRef: string): { sha256: string; sizeBytes: number } {
    const bytes = this.read(contentRef);
    return { sha256: this.hashFromRef(contentRef), sizeBytes: bytes.byteLength };
  }

  exists(contentRef: string): boolean {
    const sha256 = this.hashFromRef(contentRef);
    return existsSync(resolve(this.rootDir, this.storagePathForHash(sha256)));
  }

  private verifyHash(sha256: string): void {
    const path = resolve(this.rootDir, this.storagePathForHash(sha256));
    if (!existsSync(path)) throw new Error(`CONTENT_WRITE_FAILED: content object missing after write: ${sha256}`);
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error(`CONTENT_WRITE_FAILED: content object is not a file: ${sha256}`);
    const actualHash = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (actualHash !== sha256) throw new Error(`CONTENT_HASH_MISMATCH: expected ${sha256}, actual ${actualHash}.`);
  }

  private storagePathForHash(sha256: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`CONTENT_REF_INVALID: invalid SHA-256: ${sha256}`);
    return join('sha256', sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  private hashFromRef(contentRef: string): string {
    const hash = contentRef.startsWith('content:') ? contentRef.slice('content:'.length) : contentRef;
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`CONTENT_REF_INVALID: ${contentRef}`);
    return hash;
  }

  private isWithinRoot(path: string): boolean {
    const root = resolve(this.rootDir);
    const child = resolve(path);
    const relation = relative(root, child);
    return child === root || (relation !== '..' && !relation.startsWith(`..${sep}`));
  }
}
