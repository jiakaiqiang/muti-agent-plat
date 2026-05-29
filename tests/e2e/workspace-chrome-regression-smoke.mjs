import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const workspaceSource = readFileSync(join(root, 'apps/web/src/components/SessionWorkspace.vue'), 'utf8');
const agentPanelSource = readFileSync(join(root, 'apps/web/src/components/AgentStatusPanel.vue'), 'utf8');

const requiredWorkspacePatterns = [
  { pattern: /type WorkspaceSection = 'session' \| 'knowledge' \| 'settings' \| 'models' \| 'tools' \| 'notifications'/, reason: '工作台需要保留原有功能区状态' },
  { pattern: /const railSections:/, reason: '左侧主导航需要由功能区配置驱动' },
  { pattern: /@click="activateRailSection\(section\.id\)"/, reason: '左侧入口需要可切换，不应只是空按钮' },
  { pattern: /v-(?:else-)?if="activeSection === 'knowledge'"/, reason: '知识库入口需要有真实内容面板' },
  { pattern: /knowledgeStore\.knowledgeBases/, reason: '知识库面板需要使用真实知识库状态' },
  { pattern: /v-else-if="activeSection === 'settings'"/, reason: '设置入口需要恢复内容面板' },
  { pattern: /v-else-if="activeSection === 'models'"/, reason: '模型管理入口需要恢复内容面板' },
  { pattern: /v-else-if="activeSection === 'tools'"/, reason: '工具集成入口需要恢复内容面板' },
  { pattern: /v-else-if="activeSection === 'notifications'"/, reason: '通知中心入口需要恢复内容面板' },
  { pattern: /@create="openCreateSessionDialog"/, reason: '新建会话入口需要打开创建会话弹窗' },
  { pattern: /@create-agent="createAgent"/, reason: 'Agent 添加功能需要保留' }
];

const requiredChineseLabels = [
  '知识库',
  '设置',
  '模型管理',
  '工具集成',
  '通知中心',
  '新建会话',
  '添加 Agent',
  '任务执行步骤',
  '展开全部',
  '收起全部'
];

const forbiddenPatterns = [
  { pattern: /@\/mock\/mockEvents/, reason: '工作台不能重新导入 mock fixtures' },
  { pattern: /mockAgents|mockSessions|mockEvents|mockKnowledgeBases/, reason: '工作台不能引用 mock 数据变量' },
  { pattern: /Frontend|Backend|Mock data|mock team/i, reason: '用户可见主界面不应退回英文 mock 演示文案' }
];

const failures = [];

for (const { pattern, reason } of requiredWorkspacePatterns) {
  if (!pattern.test(workspaceSource)) {
    failures.push(`SessionWorkspace.vue: ${reason}`);
  }
}

for (const label of requiredChineseLabels) {
  if (!workspaceSource.includes(label) && !agentPanelSource.includes(label)) {
    failures.push(`缺少中文界面文案：${label}`);
  }
}

for (const { pattern, reason } of forbiddenPatterns) {
  if (pattern.test(workspaceSource) || pattern.test(agentPanelSource)) {
    failures.push(reason);
  }
}

if (failures.length) {
  throw new Error(`workspace chrome regression smoke failed:\n${failures.join('\n')}`);
}

console.log('workspace chrome regression smoke ok');
