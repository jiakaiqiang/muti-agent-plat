import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeController } from './runtime.controller.js';

test('local credential failures return a safe error without leaking PowerShell diagnostics', async () => {
  const config = {
    currentModelId: 'remote:openai-compatible:local:device-1:test-model',
    availableModels: []
  };
  const modelConfig = {
    async addModel(_input: unknown, provision?: (value: typeof config, affectedModelId: string) => Promise<void>) {
      await provision?.(config, config.currentModelId);
      return config;
    }
  };
  const localRuntime = {
    async upsertProviderConnection() {
      throw new Error('Security.Cryptography.ProtectedData TypeNotFound');
    }
  };
  const controller = new RuntimeController({} as never, modelConfig as never, localRuntime as never);

  await assert.rejects(
    () => controller.addModel({
      kind: 'remote',
      provider: 'openai-compatible',
      credentialLocation: 'local',
      deviceId: 'device-1',
      model: 'test-model',
      baseUrl: 'https://model.test/v1',
      apiKey: 'sk-test'
    }),
    (error: unknown) => {
      const candidate = error as { getStatus?: () => number; message?: string };
      assert.equal(candidate.getStatus?.(), 502);
      assert.match(candidate.message ?? '', /Local Runtime/);
      assert.doesNotMatch(candidate.message ?? '', /ProtectedData|TypeNotFound|sk-test/);
      return true;
    }
  );
});

test('updating a non-current local model provisions the affected connection id', async () => {
  const currentModel = {
    id: 'remote:openai-compatible:server:current:current-model',
    credentialLocation: 'server'
  };
  const editedModel = {
    id: 'remote:openai-compatible:local:device-1:edited-model',
    credentialLocation: 'local',
    provider: 'openai-compatible',
    deviceId: 'device-1',
    model: 'edited-model',
    baseUrl: 'https://edited.test/v1'
  };
  const config = {
    currentModelId: currentModel.id,
    availableModels: [currentModel, editedModel]
  };
  const modelConfig = {
    async updateModel(
      _modelId: string,
      _input: unknown,
      provision?: (value: typeof config, affectedModelId: string) => Promise<void>
    ) {
      await provision?.(config, editedModel.id);
      return config;
    }
  };
  const calls: Array<{ deviceId: string; connectionId: string }> = [];
  const localRuntime = {
    async upsertProviderConnection(deviceId: string, connection: { connectionId: string }) {
      calls.push({ deviceId, connectionId: connection.connectionId });
    }
  };
  const controller = new RuntimeController({} as never, modelConfig as never, localRuntime as never);

  await controller.updateModel(editedModel.id, { apiKey: 'sk-replacement' });

  assert.deepEqual(calls, [{ deviceId: 'device-1', connectionId: editedModel.id }]);
});
