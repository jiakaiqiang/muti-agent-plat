import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createExecutionTermination } from '../../common/execution-termination.js';
import { ExecutionService } from '../execution/execution.service.js';
import { ExecutionQueue } from '../queue/execution.queue.js';
import { BrokerGateway } from '../workspaces/runtime-broker/broker-gateway.js';
import { PendingRequestRegistry } from '../workspaces/runtime-broker/pending-request-registry.js';
import { PersistenceService } from './persistence.service.js';

export type MaintenanceStatus = {
  status: 'active';
  reason: string;
  requestedBy: string;
  dataEpoch: string;
  invalidatedWorkspaceCount: number;
  rejectedRequestCount: number;
  cancellationRequestedCount: number;
  cancellationCompletedCount: number;
  cancellationTimedOutSessionIds: string[];
};

@Injectable()
export class MaintenanceCoordinatorService {
  private active?: MaintenanceStatus;
  private entering?: Promise<MaintenanceStatus>;

  constructor(
    private readonly persistence: PersistenceService,
    private readonly execution: ExecutionService,
    private readonly executionQueue: ExecutionQueue,
    private readonly gateway: BrokerGateway,
    private readonly pending: PendingRequestRegistry
  ) {}

  enter(input: { reason: string; requestedBy: string }): Promise<MaintenanceStatus> {
    if (this.active) {
      return Promise.resolve(this.active);
    }
    if (this.entering) {
      return this.entering;
    }
    this.entering = this.performEnter(input).finally(() => {
      this.entering = undefined;
    });
    return this.entering;
  }

  current(): MaintenanceStatus | undefined {
    return this.active;
  }

  private async performEnter(input: { reason: string; requestedBy: string }): Promise<MaintenanceStatus> {
    this.persistence.enterMaintenanceMode();
    const termination = createExecutionTermination({
      kind: 'maintenance',
      source: 'operator',
      scope: 'service',
      maintenanceId: randomUUID(),
      diagnosticRef: input.reason
    });
    const cancellation = await this.execution.cancelAllAndWait(termination);
    await this.executionQueue.pauseForMaintenance(termination);

    const registrations = this.gateway.listRegistrations();
    let rejectedRequestCount = 0;
    for (const registration of registrations) {
      rejectedRequestCount += this.pending.rejectByWorkspace(
        registration.workspaceId,
        new Error(`MAINTENANCE_MODE: ${input.reason}`)
      );
    }
    this.gateway.invalidateAll(input.reason);
    this.active = {
      status: 'active',
      reason: input.reason,
      requestedBy: input.requestedBy,
      dataEpoch: this.persistence.currentDataEpoch(),
      invalidatedWorkspaceCount: registrations.length,
      rejectedRequestCount,
      cancellationRequestedCount: cancellation.requestedCount,
      cancellationCompletedCount: cancellation.completedCount,
      cancellationTimedOutSessionIds: cancellation.timedOutSessionIds
    };
    return this.active;
  }
}
