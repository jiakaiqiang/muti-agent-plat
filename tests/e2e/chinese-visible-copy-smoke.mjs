import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

const files = [
  'apps/web/src/components/SessionWorkspace.vue',
  'apps/web/src/components/AgentStatusPanel.vue',
  'apps/web/src/components/AgentManager.vue',
  'apps/web/src/components/SessionSidebar.vue',
  'apps/web/src/components/UserInputBox.vue',
  'apps/web/index.html',
  'apps/server/src/main.ts',
  'apps/server/src/common/messages.ts',
  'apps/server/src/modules/capabilities/default-capabilities.ts',
  'apps/server/src/modules/orchestrator/orchestrator.service.ts',
  'apps/server/src/modules/sessions/sessions.service.ts',
  'apps/server/src/modules/sessions/sessions.controller.ts'
];

const forbiddenVisibleCopy = [
  /Session failed during/,
  /Session status changed to/,
  /Paused by user/,
  /Resumed by user/,
  /Cancelled by user/,
  /No participating Agent is available/,
  /Agent Collaboration Workspace/,
  /Generate Task Brief|Route User Message|Generate Test Report|Command Execution/,
  /Mock data/,
  /falling back to mock data/i
];

const requiredCopy = [
  '多 Agent 协同工作平台',
  '添加 Agent',
  '新建会话',
  '任务执行步骤',
  '任务契约生成',
  'Agent 团队已生成任务契约',
  '命令执行',
  '用户选择了',
  '新协作会话',
  'http://127.0.0.1:5173'
];

const combined = files.map((file) => readFileSync(join(root, file), 'utf8')).join('\n');
const failures = [];

for (const pattern of forbiddenVisibleCopy) {
  if (pattern.test(combined)) {
    failures.push(`仍存在用户可见英文文案：${pattern}`);
  }
}

for (const copy of requiredCopy) {
  if (!combined.includes(copy)) {
    failures.push(`缺少中文关键文案：${copy}`);
  }
}

if (failures.length) {
  throw new Error(`Chinese visible copy smoke failed:\n${failures.join('\n')}`);
}

console.log('chinese visible copy smoke ok');
