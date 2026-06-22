import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tool, ToolCategory } from './tool.interface.js';
import { ToolRegistryService } from './tool-registry.service.js';

function makeTool(name: string, category: ToolCategory = 'file'): Tool {
  return {
    name,
    description: `${name} description`,
    category,
    riskLevel: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string' }
      }
    },
    async execute() {
      return { success: true, output: name };
    }
  };
}

test('registerTool stores a tool by name', () => {
  const registry = new ToolRegistryService();
  const tool = makeTool('read_file');

  registry.registerTool(tool);

  assert.equal(registry.getTool('read_file'), tool);
});

test('getTool returns undefined for unknown tools', () => {
  const registry = new ToolRegistryService();

  assert.equal(registry.getTool('missing'), undefined);
});

test('registerTool overwrites tools with the same name', () => {
  const registry = new ToolRegistryService();
  const first = makeTool('read_file');
  const second = makeTool('read_file', 'code');

  registry.registerTool(first);
  registry.registerTool(second);

  assert.equal(registry.getTool('read_file'), second);
  assert.equal(registry.listAll().length, 1);
});

test('getToolsByCategory filters registered tools', () => {
  const registry = new ToolRegistryService();
  const fileTool = makeTool('read_file', 'file');
  const testTool = makeTool('run_test', 'test');

  registry.registerTool(fileTool);
  registry.registerTool(testTool);

  assert.deepEqual(registry.getToolsByCategory('file'), [fileTool]);
  assert.deepEqual(registry.getToolsByCategory('test'), [testTool]);
});

test('getToolsByCategory returns an empty array when no tools match', () => {
  const registry = new ToolRegistryService();
  registry.registerTool(makeTool('read_file', 'file'));

  assert.deepEqual(registry.getToolsByCategory('network'), []);
});

test('listAll returns all tools in registration order', () => {
  const registry = new ToolRegistryService();
  const first = makeTool('read_file');
  const second = makeTool('search_code', 'code');

  registry.registerTool(first);
  registry.registerTool(second);

  assert.deepEqual(registry.listAll(), [first, second]);
});

test('listAll returns an empty array before registration', () => {
  const registry = new ToolRegistryService();

  assert.deepEqual(registry.listAll(), []);
});

test('listDescriptors exposes runtime-visible descriptors', () => {
  const registry = new ToolRegistryService();
  registry.registerTool(makeTool('read_file'));

  assert.deepEqual(registry.listDescriptors(), [
    {
      name: 'read_file',
      description: 'read_file description',
      inputSchema: {
        type: 'object',
        properties: {
          value: { type: 'string' }
        }
      }
    }
  ]);
});

test('listDescriptors does not expose internal execution fields', () => {
  const registry = new ToolRegistryService();
  registry.registerTool(makeTool('read_file'));

  const [descriptor] = registry.listDescriptors() as Array<Record<string, unknown>>;

  assert.equal('execute' in descriptor, false);
  assert.equal('riskLevel' in descriptor, false);
  assert.equal('category' in descriptor, false);
});
