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
import { minimalTaskSubmissionContract } from './minimal-submission.js';

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

export function getVersionedRuntimeOutputContract(kind: RuntimeOutputKind, version: string = '1.0') {
  if (version === '1.0') return getRuntimeOutputContract(kind);
  if (kind === 'task_execution_result' && version === '2.0') return minimalTaskSubmissionContract;
  throw new Error(`RUNTIME_OUTPUT_CONTRACT_NOT_FOUND: ${kind}@${version}`);
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
  assertStrictJsonSchema(minimalTaskSubmissionContract.schema);
  if (!minimalTaskSubmissionContract.validate(minimalTaskSubmissionContract.example).valid) {
    throw new Error('RUNTIME_OUTPUT_CONTRACT_EXAMPLE_INVALID: task_execution_result@2.0');
  }
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

/**
 * Ajv keeps the offending property name in `params`, not in `message`, so two
 * distinct violations render as the same sentence. Naming the property is the
 * difference between a diagnosable failure and having to dig the submitted
 * arguments out of the event store.
 */
function formatValidationError(error: ErrorObject) {
  const path = error.instancePath || '/';
  const property = offendingProperty(error);
  if (property && error.keyword === 'required') {
    return `${path} must have required property: ${property}`;
  }
  if (property && error.keyword === 'additionalProperties') {
    return `${path} must NOT have additional properties: ${property}`;
  }
  const message = error.message ?? error.keyword;
  return `${path} ${message}${property ? `: ${property}` : ''}`.trim();
}

function offendingProperty(error: ErrorObject): string | undefined {
  const params = error.params as Record<string, unknown>;
  const named = params.additionalProperty ?? params.missingProperty;
  return typeof named === 'string' ? named : undefined;
}
