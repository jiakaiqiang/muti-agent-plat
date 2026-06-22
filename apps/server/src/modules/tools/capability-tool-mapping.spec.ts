import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultCapabilities } from '../capabilities/default-capabilities.js';
import {
  CAPABILITY_TOOL_MAPPING,
  getToolsForCapabilities,
  getToolsForCapability,
  hasToolsForCapability,
  PLANNED_TOOL_CAPABILITY_IDS
} from './capability-tool-mapping.js';

test('cap-file-write maps to read_file and write_file', () => {
  assert.deepEqual(getToolsForCapability('cap-file-write'), ['read_file', 'write_file']);
});

test('cap-command-run maps to run_test', () => {
  assert.deepEqual(getToolsForCapability('cap-command-run'), ['run_test']);
});

test('unknown capabilities return an empty array', () => {
  assert.deepEqual(getToolsForCapability('cap-unknown'), []);
});

test('hasToolsForCapability returns true only when tools are mapped', () => {
  assert.equal(hasToolsForCapability('cap-file-write'), true);
  assert.equal(hasToolsForCapability('cap-feishu-draft'), false);
  assert.equal(hasToolsForCapability('cap-unknown'), false);
});

test('getToolsForCapabilities returns unique tools in first-seen order', () => {
  assert.deepEqual(getToolsForCapabilities(['cap-file-read', 'cap-file-write', 'cap-command-run']), [
    'read_file',
    'write_file',
    'run_test'
  ]);
});

test('returned tool arrays are defensive copies', () => {
  const tools = getToolsForCapability('cap-file-read');
  tools.push('mutated_tool');

  assert.deepEqual(getToolsForCapability('cap-file-read'), ['read_file']);
});

test('all current default capabilities have explicit mapping entries', () => {
  const defaultCapabilityIds = defaultCapabilities.map((capability) => capability.id);

  assert.deepEqual(
    defaultCapabilityIds.filter((capabilityId) => !(capabilityId in CAPABILITY_TOOL_MAPPING)),
    []
  );
});

test('planned tool capabilities are explicitly tracked outside default capabilities', () => {
  const defaultCapabilityIds = new Set(defaultCapabilities.map((capability) => capability.id));

  assert.deepEqual(PLANNED_TOOL_CAPABILITY_IDS, ['cap-file-read', 'cap-code-search']);
  assert.deepEqual(
    PLANNED_TOOL_CAPABILITY_IDS.filter((capabilityId) => defaultCapabilityIds.has(capabilityId)),
    []
  );
});

test('mapping keys use capability ids instead of legacy ability names', () => {
  const mappingKeys = Object.keys(CAPABILITY_TOOL_MAPPING);

  assert.equal(mappingKeys.every((key) => key.startsWith('cap-')), true);
  assert.equal(mappingKeys.includes('code_read'), false);
  assert.equal(mappingKeys.includes('code_edit'), false);
});
