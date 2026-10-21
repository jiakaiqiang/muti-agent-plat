async page => {
  const checks = [], errors = [];
  const check = (id, condition) => { if (!condition) throw new Error(id); checks.push({ id, passed: true }); };
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (/Content Security Policy|unsafe-eval|EvalError/i.test(message.text())) errors.push(message.text()); });
  for (const client of ['web', 'desktop']) {
    await page.goto(`http://127.0.0.1:4187/tests/fixtures/intent-multi-segment-review.html?client=${client}`);
    const panel = page.getByRole('region', { name: '多项意图待澄清' });
    await panel.getByRole('status').filter({ hasText: '整组等待澄清' }).waitFor();
    check(`${client}_eight_complete_under_csp`, await panel.locator('ol > li').count() === 8 && await panel.locator('script').count() === 0);
    const details = panel.locator('summary').first(); await details.focus(); await page.keyboard.press('Enter');
    check(`${client}_keyboard_evidence`, await panel.locator('details').first().getAttribute('open') !== null && await panel.locator('blockquote').first().isVisible());
    await page.setViewportSize({ width: 390, height: 844 });
    check(`${client}_mobile_width`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `output/playwright/intent-multi-segment-${client}.png`, fullPage: true });
    await panel.getByRole('button', { name: '核对当前状态' }).click();
    await panel.getByRole('status').filter({ hasText: '整组等待澄清' }).waitFor();
    check(`${client}_read_only`, await page.evaluate(() => window.intentReviewFixture.requests.every(request => request.method === 'GET')));
    await page.evaluate(() => window.intentReviewFixture.change());
    await panel.getByRole('status').filter({ hasText: '路由状态已变化' }).waitFor();
    check(`${client}_historical_after_event`, await panel.locator('ol > li').count() === 8);
  }
  check('no_csp_or_javascript_errors', errors.length === 0);
  return { checks, errors, scope: 'Chromium with desktop script-src self CSP, real Web/Desktop timeline components and deterministic local GET fixture; not Electron/SSE network E2E' };
}
