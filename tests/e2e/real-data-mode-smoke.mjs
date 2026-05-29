import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

const productionFiles = [
  'apps/web/src/stores/agent.ts',
  'apps/web/src/stores/event.ts',
  'apps/web/src/stores/knowledge.ts',
  'apps/web/src/stores/session.ts',
  'apps/web/src/components/SessionWorkspace.vue',
  'apps/web/src/components/WorkflowRuntimeView.vue'
];

const forbiddenPatterns = [
  { pattern: /@\/mock\/mockEvents/, reason: 'production app state must not import frontend mock fixtures' },
  { pattern: /mockFallbackEnabled/, reason: 'production app state must fail visibly instead of falling back to mock data' },
  { pattern: /mockSessionId|mockSession|mockSessions|mockEvents|mockAgents|mockKnowledgeBases/, reason: 'production app state must not reference mock fixtures' },
  { pattern: /张三|智能营销方案制定/, reason: 'workspace chrome must derive visible data from real session/agent state' }
];

const failures = [];

for (const relativePath of productionFiles) {
  const absolutePath = join(root, relativePath);
  const source = readFileSync(absolutePath, 'utf8');
  for (const { pattern, reason } of forbiddenPatterns) {
    if (pattern.test(source)) {
      failures.push(`${relativePath}: ${reason} (${pattern})`);
    }
  }
}

if (failures.length) {
  throw new Error(`Real data mode smoke failed:\n${failures.join('\n')}`);
}

console.log('real data mode smoke ok');
