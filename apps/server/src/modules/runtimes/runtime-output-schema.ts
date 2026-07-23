import {
  assertRuntimeContractsReady,
  getRuntimeOutputContract,
  validateRuntimeOutput as validateRegisteredRuntimeOutput,
  type RuntimeOutputKind
} from '@agent-cluster/shared';

assertRuntimeContractsReady();

export type { RuntimeOutputKind };

export function runtimeOutputSchema(kind: RuntimeOutputKind): Record<string, unknown> {
  return getRuntimeOutputContract(kind).schema as Record<string, unknown>;
}

export function runtimeOutputExample(kind: RuntimeOutputKind): Record<string, unknown> {
  return getRuntimeOutputContract(kind).example as unknown as Record<string, unknown>;
}

export function runtimeOutputContractAudit(kind: RuntimeOutputKind) {
  const contract = getRuntimeOutputContract(kind);
  return {
    contractId: contract.contractId,
    contractVersion: contract.version,
    schemaHash: contract.schemaHash
  } as const;
}

export function validateRuntimeOutput(value: unknown, kind: RuntimeOutputKind) {
  return validateRegisteredRuntimeOutput(kind, value);
}
