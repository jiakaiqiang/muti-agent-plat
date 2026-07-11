import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  waitForStatus
} from './smoke-server.mjs';
import {
  assertVisible,
  startBrowserCollaborationSmoke,
  stopBrowserCollaborationSmoke
} from './browser-smoke-utils.mjs';

await buildServer();
let handle;

try {
  handle = await startBrowserCollaborationSmoke('skill-management-browser-smoke', {
    DISCUSSION_MAX_ROUNDS: '0'
  });
  const { page, server, web } = handle;
  await page.goto(`${web.webBase}/?view=chat`, { waitUntil: 'domcontentloaded' });

  await page.getByTitle('Skill 管理').click();
  await assertVisible(page, 'Skill 管理', 'Skill 管理标题');
  await page.getByRole('button', { name: '新建 Skill' }).click();
  await page.getByTestId('skill-name').fill('Release Checklist');
  await page.getByTestId('skill-description').fill('在交付前执行必要的检查。');
  await page.getByTestId('skill-content').fill('Always run typecheck and summarize residual risks before delivery.');
  await page.getByTestId('skill-add-file').click();
  await page.getByTestId('skill-file-path-0').fill('checklists/release.md');
  await page.getByTestId('skill-file-content-0').fill('Run typecheck.');
  await page.getByTestId('skill-save').click();

  await assertVisible(page, 'Release Checklist', '创建后的 Skill');
  const skills = await api(server.apiBase, '/skills');
  const skill = skills.data.find((item) => item.name === 'Release Checklist');
  if (!skill) throw new Error('Skill must be persisted after the browser creates it');
  const requirementsAgent = await api(server.apiBase, '/agents/requirements');
  const requirementsAgentId = requirementsAgent.data.id;

  await page.getByTestId(`skill-binding-${requirementsAgentId}`).click();
  await page.getByTestId('skill-preview-agent').selectOption(requirementsAgentId);
  await assertVisible(page, '[Skill:Release Checklist]', 'Skill 注入预览');
  const previewText = await page.locator('.skill-injection-preview').innerText();
  if (previewText.includes('Always run typecheck and summarize residual risks before delivery.')) {
    throw new Error('Injection preview must not expose the complete Skill content');
  }

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Implement a small release note update using the bound checklist skill.'
  );
  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 60_000);
  const packs = await api(server.apiBase, `/sessions/${sessionId}/debug/context-packs`);
  const requirementsPack = packs.data.items.find(
    (item) => item.agentKey === 'requirements' && item.phase === 'task_execution'
  );
  if (!requirementsPack?.contextPack?.systemRules?.some((rule) => rule.startsWith('[Skill:Release Checklist]'))) {
    throw new Error('Bound Skill must be injected into the next requirements Agent ContextPack');
  }

  await page.getByTestId(`skill-delete-${skill.id}`).click();
  await assertVisible(page, '将解除以下 Agent 的绑定', '删除影响提示');
  await assertVisible(page, requirementsAgent.data.name, '受影响 Agent');
  await page.getByTestId('skill-confirm-delete').click();
  await page.getByText('暂无 Skill。新建后可将其绑定给一个或多个 Agent。').waitFor({ state: 'visible' });

  const requirementsAfterDelete = await api(server.apiBase, '/agents/requirements');
  if ((requirementsAfterDelete.data.skillIds ?? []).includes(skill.id)) {
    throw new Error('Deleting a Skill must clean the Agent skillIds reference');
  }

  console.log('skill management browser smoke ok');
} finally {
  if (handle) await stopBrowserCollaborationSmoke(handle);
}
