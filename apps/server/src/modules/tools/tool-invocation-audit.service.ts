import { Injectable } from '@nestjs/common';
import { PersistenceService } from '../persistence/persistence.service.js';
import type { McpObservationRecord } from '../persistence/relational/relational-state-store.js';

export type ToolAuditInput = {
  externalId: string;
  runtimeInvocationExternalId?: string;
  sessionExternalId?: string;
  toolName: string;
  providerCallId?: string;
  provider?: string;
  arguments: unknown;
  result?: unknown;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
  agentExternalId?: string;
  authoritySnapshot?: Record<string, unknown>;
  startedAt: string;
  completedAt: string;
};

@Injectable()
export class ToolInvocationAuditService {
  constructor(private readonly persistence: PersistenceService) {}

  record(input: ToolAuditInput): Promise<boolean> {
    return this.persistence.recordToolInvocation({
      ...input,
      arguments: redactSecrets(input.arguments),
      result: redactSecrets(input.result),
      errorMessage: input.errorMessage ? String(redactSecrets(input.errorMessage)) : undefined,
      status: input.success ? 'completed' : 'failed'
    });
  }

  recordMcp(input: McpObservationRecord): Promise<boolean> {
    return this.persistence.recordMcpObservation({
      ...input,
      arguments: redactSecrets(input.arguments),
      result: redactSecrets(input.result),
      errorMessage: input.errorMessage ? String(redactSecrets(input.errorMessage)) : undefined
    });
  }
}

const SECRET_KEY = /(?:authorization|api[_-]?key|token|password|passwd|secret|cookie|credential)/i;

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[REDACTED]' : redactSecrets(item)])
  );
}
