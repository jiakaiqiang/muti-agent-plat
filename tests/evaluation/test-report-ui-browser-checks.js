async page => {
  const checks = [], check = (id, condition) => { if (!condition) throw new Error(id); checks.push({ id, passed: true }); };
  const checkbox = page.getByRole('checkbox', { name: '允许保存会话测试报告' });
  await page.getByText('已允许保存会话测试报告；报告不会写入源码目录。', { exact: true }).waitFor();
  check('RU01_explicit_opt_in', await checkbox.isChecked());
  await checkbox.uncheck(); await page.getByRole('button', { name: '允许所选测试', exact: true }).click();
  await page.getByText('已允许保存会话测试报告；报告不会写入源码目录。', { exact: true }).waitFor({ state: 'hidden' });
  check('RU02_remove_report_keep_test', await page.getByRole('status').filter({ hasText: '已允许 test:unit' }).isVisible());
  const posts = []; let drop = true, replay = false;
  await page.route('**/intent-test-authority', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    posts.push(route.request().postData()); const response = await route.fetch(), result = await response.json();
    if (response.status() !== 201) throw new Error('unexpected mutation response');
    if (drop) { drop = false; return route.abort('failed'); }
    replay = result.data.idempotentReplay === true; return route.fulfill({ response });
  });
  await checkbox.check(); await page.getByRole('button', { name: '允许所选测试', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '提交结果尚未确认' }).waitFor();
  await page.reload(); await page.getByRole('button', { name: '重试原测试授权请求', exact: true }).waitFor();
  check('RU03_reload_preserves_report_flag', await checkbox.isChecked() && await checkbox.isDisabled());
  await page.getByRole('button', { name: '重试原测试授权请求', exact: true }).click();
  await page.getByRole('button', { name: '重试原测试授权请求', exact: true }).waitFor({ state: 'hidden' });
  check('RU04_replay_no_new_grant', posts.length === 2 && posts[0] === posts[1] && JSON.parse(posts[0]).writeReport === true && replay);
  await page.unroute('**/intent-test-authority');
  await page.setViewportSize({ width: 390, height: 844 });
  check('RU05_mobile_no_overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'output/playwright/test-report-ui-mobile.png', fullPage: true });
  await checkbox.focus(); await page.keyboard.press('Space');
  check('RU06_keyboard_checkbox', !(await checkbox.isChecked()));
  await page.getByRole('button', { name: '允许所选测试', exact: true }).click();
  await page.getByText('已允许保存会话测试报告；报告不会写入源码目录。', { exact: true }).waitFor({ state: 'hidden' });
  return { checks, unknownOutcomeReplay: replay, script: 'test:unit', reportGrantRemoved: true };
}
