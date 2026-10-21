async page => {
  const [first, second] = page.context().pages();
  const checks = [];
  const check = (id, condition) => { if (!condition) throw new Error(id); checks.push({ id, passed: true }); };
  await first.getByRole('combobox', { name: '测试脚本' }).selectOption('test:unit');
  await first.getByRole('button', { name: '允许所选测试', exact: true }).click();
  await first.getByRole('status').filter({ hasText: '已允许 test:unit' }).waitFor();
  check('TU01_explicit_script_grant', true);
  await second.getByRole('combobox', { name: '测试脚本' }).selectOption('test:integration');
  await second.getByRole('button', { name: '允许所选测试', exact: true }).click();
  await second.getByRole('alert').filter({ hasText: '授权状态已发生变化' }).waitFor();
  await second.getByRole('status').filter({ hasText: '已允许 test:unit' }).waitFor();
  check('TU02_stale_tab_conflict_refresh', true);
  await first.getByRole('button', { name: '撤销测试授权', exact: true }).click();
  await first.getByRole('status').filter({ hasText: '已撤销测试授权' }).waitFor();
  await second.getByRole('button', { name: '刷新测试状态', exact: true }).click();
  await second.getByRole('status').filter({ hasText: '已撤销测试授权' }).waitFor();
  check('TU03_revoke_other_tab_refresh', true);
  const posts = []; let drop = true, replay = false;
  await first.route('**/intent-test-authority', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    posts.push(route.request().postData());
    const response = await route.fetch(), result = await response.json();
    if (response.status() !== 201) throw new Error('unexpected mutation response');
    if (drop) { drop = false; return route.abort('failed'); }
    replay = result.data.idempotentReplay === true;
    return route.fulfill({ response });
  });
  await first.getByRole('combobox', { name: '测试脚本' }).selectOption('test:integration');
  await first.getByRole('button', { name: '允许所选测试', exact: true }).click();
  await first.getByRole('alert').filter({ hasText: '提交结果尚未确认' }).waitFor();
  await first.reload();
  await first.getByRole('button', { name: '重试原测试授权请求', exact: true }).waitFor();
  check('TU04_reload_preserves_unknown_request', await first.getByRole('combobox', { name: '测试脚本' }).isDisabled());
  await first.getByRole('button', { name: '重试原测试授权请求', exact: true }).click();
  await first.getByRole('button', { name: '重试原测试授权请求', exact: true }).waitFor({ state: 'hidden' });
  check('TU05_retry_original_identity_only_once', posts.length === 2 && posts[0] === posts[1] && replay);
  await first.unroute('**/intent-test-authority');
  await first.setViewportSize({ width: 390, height: 844 });
  check('TU06_mobile_no_horizontal_overflow', await first.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await first.screenshot({ path: 'D:/demo/muti-agent/muti-agent-plat/docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development/test-authority-ui-mobile.png', fullPage: true });
  let focused = false;
  for (let i = 0; i < 10; i++) {
    await first.keyboard.press('Tab');
    focused = await first.evaluate(() => document.activeElement?.textContent === '撤销测试授权');
    if (focused) break;
  }
  check('TU07_keyboard_focus', focused);
  await first.keyboard.press('Enter');
  await first.getByRole('status').filter({ hasText: '已撤销测试授权' }).waitFor();
  check('TU08_keyboard_revoke', true);
  await first.setViewportSize({ width: 1280, height: 800 });
  await first.screenshot({ path: 'D:/demo/muti-agent/muti-agent-plat/docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development/test-authority-ui-desktop.png', fullPage: true });
  return { browserChecks: checks, uncertainPostCount: posts.length, retryIdempotent: replay };
}
