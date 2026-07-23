export interface WorkspaceHandleRecord {
  handleId: string;
  workspaceId: string;
  displayName: string;
  registeredAt: string;
}

export interface WorkspaceHandleValue<HandleT = unknown> {
  record: WorkspaceHandleRecord;
  handle: HandleT;
}

export class WorkspaceHandleRegistry<HandleT = unknown> {
  private readonly store = new Map<string, WorkspaceHandleValue<HandleT>>();

  register(record: WorkspaceHandleRecord, handle: HandleT): void {
    this.store.set(record.handleId, { record, handle });
  }

  get(handleId: string): WorkspaceHandleValue<HandleT> | undefined {
    return this.store.get(handleId);
  }

  has(handleId: string): boolean {
    return this.store.has(handleId);
  }

  drop(handleId: string): boolean {
    return this.store.delete(handleId);
  }

  list(): WorkspaceHandleRecord[] {
    return Array.from(this.store.values(), (value) => value.record);
  }

  clear(): void {
    this.store.clear();
  }
}
