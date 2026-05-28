import { Injectable, Logger } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

type PersistedState = Record<string, unknown>;

@Injectable()
export class PersistenceService {
  private readonly logger = new Logger(PersistenceService.name);
  private readonly filePath: string;
  private readonly enabled: boolean;
  private state: PersistedState = {};

  constructor() {
    this.enabled = process.env.AGENT_CLUSTER_PERSISTENCE !== 'false';
    const dataDir = process.env.AGENT_CLUSTER_DATA_DIR ?? join(process.cwd(), '.cache', 'agent-cluster');
    this.filePath = resolve(process.env.AGENT_CLUSTER_DATA_FILE ?? join(dataDir, 'state.v0.1.json'));

    if (this.enabled) {
      this.state = this.readState();
    }
  }

  getCollection<T>(key: string, fallback: T): T {
    if (!this.enabled) {
      return fallback;
    }
    const value = this.state[key];
    if (value === undefined) {
      return fallback;
    }
    return this.clone(value) as T;
  }

  setCollection<T>(key: string, value: T) {
    if (!this.enabled) {
      return;
    }
    this.state[key] = this.clone(value);
    this.writeState();
  }

  private readState(): PersistedState {
    if (!existsSync(this.filePath)) {
      return {};
    }

    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedState;
    } catch (error) {
      this.logger.warn(`Ignoring unreadable persistence file ${this.filePath}: ${String(error)}`);
      return {};
    }
  }

  private writeState() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    rmSync(this.filePath, { force: true });
    renameSync(tmpPath, this.filePath);
  }

  private clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}
