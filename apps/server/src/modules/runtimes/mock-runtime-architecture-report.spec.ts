import assert from 'node:assert/strict';
import test from 'node:test';
import { makeInvocationPlan } from './invocation-plan.fixture.js';
import { MockRuntimeService } from './mock-runtime.service.js';

test('architecture mock report is grounded in the InvocationPlan L3 files', async () => {
  const previous = process.env.MOCK_RUNTIME_ENABLED;
  process.env.MOCK_RUNTIME_ENABLED = 'true';
  try {
    const plan = makeInvocationPlan({
      agent: { key: 'architect', role: 'architect', name: 'System Architect' },
      expectedOutput: { kind: 'task_execution_result', schemaVersion: '1.0' },
      contextEnvelope: {
        L0: { workspace: { rootName: 'ai-langchain' } },
        L2: { detectedStack: ['node', 'typescript'] },
        L3: {
          files: [{ path: 'src/main.ts', content: 'export const main = true;', byteLength: 25 }],
          totalByteLength: 25,
          truncated: false
        }
      }
    });
    const result = await new MockRuntimeService().start(plan).result;
    const report = result.artifacts[0];
    assert.equal(report?.metadata?.fileChanges[0]?.path, 'agent-output/project-architecture-analysis.md');
    assert.match(report?.content ?? '', /# 项目架构分析报告/);
    assert.match(report?.content ?? '', /Workspace: ai-langchain/);
    assert.match(report?.content ?? '', /技术栈: node、typescript/);
    assert.match(report?.content ?? '', /src\/main\.ts/);
  } finally {
    if (previous === undefined) delete process.env.MOCK_RUNTIME_ENABLED;
    else process.env.MOCK_RUNTIME_ENABLED = previous;
  }
});
