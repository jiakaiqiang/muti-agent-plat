import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import type { TSchema } from '@sinclair/typebox';
import {
  RUNTIME_OUTPUT_KINDS,
  type ContractValidationResult,
  type RuntimeOutputKind
} from './contract-types.js';
import {
  runtimeOutputExamples,
  runtimeOutputSchemas,
  type RuntimeOutput,
  type RuntimeOutputByKind
} from './output-contracts.js';
import { assertStrictJsonSchema } from './preflight.js';

export type RuntimeContractDefinition<T extends RuntimeOutput> = {
  contractId: `runtime.output.${T['kind']}`;
  version: '1.0';
  kind: T['kind'];
  schema: TSchema;
  schemaHash: string;
  example: T;
  validate(value: unknown): ContractValidationResult<T>;
};

const ajv = new Ajv({ allErrors: true, strict: true });
const validators = new Map<RuntimeOutputKind, ValidateFunction>();

const definitions = Object.fromEntries(
  RUNTIME_OUTPUT_KINDS.map((kind) => {
    const schema = runtimeOutputSchemas[kind];
    assertStrictJsonSchema(schema, `runtime.output.${kind}@1.0`);
    return [
      kind,
      {
        contractId: `runtime.output.${kind}`,
        version: '1.0',
        kind,
        schema,
        schemaHash: stableSchemaHash(schema),
        example: runtimeOutputExamples[kind],
        validate: (value: unknown) => validateRuntimeOutput(kind, value)
      }
    ];
  })
) as unknown as { [K in RuntimeOutputKind]: RuntimeContractDefinition<RuntimeOutputByKind[K]> };

export function getRuntimeOutputContract<K extends RuntimeOutputKind>(
  kind: K
): RuntimeContractDefinition<RuntimeOutputByKind[K]> {
  const definition = definitions[kind];
  if (!definition) throw new Error(`RUNTIME_OUTPUT_CONTRACT_NOT_FOUND: ${kind}`);
  return definition;
}

export function listRuntimeOutputContracts(): readonly RuntimeContractDefinition<RuntimeOutput>[] {
  return RUNTIME_OUTPUT_KINDS.map((kind) => definitions[kind]) as readonly RuntimeContractDefinition<RuntimeOutput>[];
}

export function validateRuntimeOutput<K extends RuntimeOutputKind>(
  kind: K,
  value: unknown
): ContractValidationResult<RuntimeOutputByKind[K]> {
  let validator = validators.get(kind);
  if (!validator) {
    validator = ajv.compile(runtimeOutputSchemas[kind]);
    validators.set(kind, validator);
  }
  if (validator(value)) {
    return { valid: true, value: structuredClone(value) as RuntimeOutputByKind[K], errors: [] };
  }
  return { valid: false, errors: (validator.errors ?? []).map(formatValidationError) };
}

export function assertRuntimeContractsReady(): void {
  const ids = new Set<string>();
  for (const definition of listRuntimeOutputContracts()) {
    if (ids.has(definition.contractId)) {
      throw new Error(`RUNTIME_OUTPUT_CONTRACT_DUPLICATE: ${definition.contractId}`);
    }
    ids.add(definition.contractId);
    assertStrictJsonSchema(definition.schema, `${definition.contractId}@${definition.version}`);
    const result = definition.validate(definition.example);
    if (!result.valid) {
      throw new Error(`RUNTIME_OUTPUT_CONTRACT_EXAMPLE_INVALID: ${definition.contractId}: ${result.errors.join('; ')}`);
    }
  }
}

function stableSchemaHash(schema: unknown): string {
  const input = canonicalJson(schema);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function formatValidationError(error: ErrorObject) {
  const path = error.instancePath || '/';
  return `${path} ${error.message ?? error.keyword}`.trim();
}
