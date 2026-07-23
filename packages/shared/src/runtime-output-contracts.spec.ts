import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RUNTIME_OUTPUT_KINDS,
  assertRuntimeContractsReady,
  assertStrictJsonSchema,
  getRuntimeOutputContract,
  listRuntimeOutputContracts
} from './runtime-contracts/index.js';

test('registers exactly the seven version 1.0 runtime output contracts', () => {
  const contracts = listRuntimeOutputContracts();
  assert.deepEqual(
    contracts.map((contract) => contract.kind),
    [...RUNTIME_OUTPUT_KINDS]
  );
  assert.equal(new Set(contracts.map((contract) => contract.contractId)).size, 7);
  assert.ok(contracts.every((contract) => contract.version === '1.0'));
  assert.ok(contracts.every((contract) => /^fnv1a32:[0-9a-f]{8}$/.test(contract.schemaHash)));
  assert.doesNotThrow(() => assertRuntimeContractsReady());
});

test('every registered example passes its own validator', () => {
  for (const kind of RUNTIME_OUTPUT_KINDS) {
    const contract = getRuntimeOutputContract(kind);
    const result = contract.validate(contract.example);
    assert.equal(result.valid, true, `${kind}: ${result.errors.join('; ')}`);
  }
});

test('all seven contracts reject missing fields, old versions, wrong kinds, and extra properties', () => {
  for (const kind of RUNTIME_OUTPUT_KINDS) {
    const contract = getRuntimeOutputContract(kind);
    const valid = structuredClone(contract.example) as Record<string, unknown>;
    const removable = Object.keys(valid).find((key) => key !== 'schemaVersion' && key !== 'kind');
    assert.ok(removable, `${kind} must contain a contract-specific field`);

    const missing = structuredClone(valid);
    delete missing[removable];
    assert.equal(contract.validate(missing).valid, false, `${kind} accepted a missing required field`);
    assert.equal(
      contract.validate({ ...valid, schemaVersion: '0.1' }).valid,
      false,
      `${kind} accepted the old schema version`
    );
    assert.equal(
      contract.validate({ ...valid, kind: kind === 'agent_message' ? 'final_delivery' : 'agent_message' }).valid,
      false,
      `${kind} accepted a mismatched kind`
    );
    assert.equal(
      contract.validate({ ...valid, providerPayload: {} }).valid,
      false,
      `${kind} accepted an unknown property`
    );
    assert.equal(
      contract.validate({ ...valid, legacyAlias: undefined }).valid,
      false,
      `${kind} silently erased an unknown undefined property before validation`
    );
  }
});

test('strict preflight rejects const without type', () => {
  assert.throws(
    () =>
      assertStrictJsonSchema({
        type: 'object',
        additionalProperties: false,
        properties: { kind: { const: 'agent_message' } },
        required: ['kind']
      }),
    /STRICT_SCHEMA_CONST_TYPE_REQUIRED/
  );
});

test('strict preflight rejects enum without type and unsupported keywords', () => {
  assert.throws(
    () => assertStrictJsonSchema({ enum: ['a', 'b'] }),
    /STRICT_SCHEMA_ENUM_TYPE_REQUIRED/
  );
  assert.throws(
    () => assertStrictJsonSchema({ type: 'string', default: 'a' }),
    /STRICT_SCHEMA_UNSUPPORTED_KEYWORD/
  );
});

test('strict preflight rejects open objects and optional properties', () => {
  assert.throws(
    () =>
      assertStrictJsonSchema({
        type: 'object',
        additionalProperties: true,
        properties: {},
        required: []
      }),
    /STRICT_SCHEMA_OBJECT_MUST_BE_CLOSED/
  );
  assert.throws(
    () =>
      assertStrictJsonSchema({
        type: 'object',
        additionalProperties: false,
        properties: { value: { type: 'string' } },
        required: []
      }),
    /STRICT_SCHEMA_ALL_PROPERTIES_REQUIRED/
  );
});
