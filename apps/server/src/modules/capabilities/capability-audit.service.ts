import { Injectable } from '@nestjs/common';
import type { RuntimeCapabilityDefinition } from '@agent-cluster/shared';
import { EventsService } from '../events/events.service.js';

type CapabilityAuditInput = {
  sessionId?: string;
  agentId?: string;
  reason?: string;
};

type CapabilityCheckResult = {
  allowed: boolean;
  code?: string;
  capability: RuntimeCapabilityDefinition;
  approvalKey: string;
  requiresUserConfirmation: boolean;
};

type CapabilityApprovalResult = {
  capability: RuntimeCapabilityDefinition;
  approved: boolean;
  approvalKey: string;
};

@Injectable()
export class CapabilityAuditService {
  constructor(private readonly events: EventsService) {}

  recordCheck(input: CapabilityAuditInput, result: CapabilityCheckResult) {
    if (!input.sessionId) {
      return;
    }

    if (!result.allowed) {
      this.events.create({
        sessionId: input.sessionId,
        type: 'tool_failed',
        fromAgentId: input.agentId,
        priority: result.capability.riskLevel === 'high' ? 'high' : 'normal',
        content: `${result.capability.name} blocked by capability policy.`,
        metadata: {
          schemaVersion: '0.1',
          renderAs: 'tool_card',
          payload: this.payload(input, result, 'blocked')
        }
      });
      return;
    }

    this.events.create({
      sessionId: input.sessionId,
      type: 'tool_called',
      fromAgentId: input.agentId,
      priority: result.capability.riskLevel === 'high' ? 'high' : 'normal',
      content: `${result.capability.name} invocation allowed by capability policy.`,
      metadata: {
        schemaVersion: '0.1',
        renderAs: 'tool_card',
        payload: this.payload(input, result, 'allowed')
      }
    });
  }

  recordApproval(input: CapabilityAuditInput, result: CapabilityApprovalResult) {
    if (!input.sessionId) {
      return;
    }

    this.events.create({
      sessionId: input.sessionId,
      type: 'tool_completed',
      fromAgentId: input.agentId,
      priority: result.capability.riskLevel === 'high' ? 'high' : 'normal',
      content: `${result.capability.name} approved for this scope.`,
      metadata: {
        schemaVersion: '0.1',
        renderAs: 'tool_card',
        payload: {
          capabilityId: result.capability.id,
          capabilityKey: result.capability.key,
          capabilityName: result.capability.name,
          riskLevel: result.capability.riskLevel,
          approvalKey: result.approvalKey,
          agentId: input.agentId,
          reason: input.reason,
          status: 'approved',
          allowed: true,
          requiresUserConfirmation: false
        }
      }
    });
  }

  private payload(input: CapabilityAuditInput, result: CapabilityCheckResult, status: 'allowed' | 'blocked') {
    return {
      capabilityId: result.capability.id,
      capabilityKey: result.capability.key,
      capabilityName: result.capability.name,
      riskLevel: result.capability.riskLevel,
      approvalKey: result.approvalKey,
      agentId: input.agentId,
      reason: input.reason,
      status,
      allowed: result.allowed,
      code: result.code,
      requiresUserConfirmation: result.requiresUserConfirmation
    };
  }
}
