/* Synthetic-only UI proof. Run against the isolated reports-preview service.
 * No provider calls, production credentials, or production database access.
 * Default mock mode proves UI states/races. --live uses seeded synthetic SQLite
 * and real report/XLSX routes for end-to-end reconciliation.
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { SignJWT } = require('jose');
const ExcelJS = require('exceljs');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const path = require('node:path');
const base = process.env.REPORTS_BASE_URL || 'http://127.0.0.1:20139';
const out = process.env.REPORTS_SHOTS || '/tmp/usage-reports-shots';
const live = process.argv.includes('--live');
const metrics = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'cacheCreationTokens', 'reasoningTokens', 'cost'];
function aggregate(requests) {
  return { requests, inputTokens: requests * 100, outputTokens: requests * 20, totalTokens: requests * 120, cachedTokens: requests * 10, cacheCreationTokens: null, reasoningTokens: requests * 5, cost: requests * .001, known: Object.fromEntries(metrics.map(m => [m, m === 'cacheCreationTokens' ? 0 : requests])) };
}
function fixture(url) {
  const p = url.searchParams;
  const total = p.get('keyId') === 'kenny' ? 31 : 62;
  const page = Number(p.get('page') || 1);
  return { filters: Object.fromEntries(p), cutoff: 62, limits: { maxDays: 366, maxExportRows: 50000 }, summary: aggregate(total), daily: [{ date: p.get('startDate'), ...aggregate(total) }], byModel: [{ provider: 'codex', model: 'gpt-test', ...aggregate(total) }], byAccount: [{ provider: 'codex', connectionId: 'account-test', accountName: 'Synthetic account', ...aggregate(total) }], requests: Array.from({ length: Math.max(0, Math.min(25, total - (page - 1) * 25)) }, (_, i) => ({ id: (page - 1) * 25 + i, timestamp: '2026-10-15T12:00:00.000Z', provider: 'codex', model: 'gpt-test', keyId: 'kenny', keyName: 'Kenny (synthetic)', connectionId: 'account-test', accountName: 'Synthetic account', ...aggregate(1) })), pagination: { page, pageSize: 25, total, totalPages: Math.ceil(total / 25) }, options: { keys: [{ id: 'kenny', name: 'Kenny (synthetic)' }, { id: 'other', name: 'Other (synthetic)' }], providers: ['codex'], accounts: [{ id: 'account-test', name: 'Synthetic account' }], models: [{ provider: 'codex', model: 'gpt-test' }] } };
}
(async () => {
  await fs.mkdir(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/New_York' });
  const token = await new SignJWT({ authenticated: true }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode('synthetic-reports-browser-secret'));
  await context.addCookies([{ name: 'auth_token', value: token, url: base }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  let mode = 'normal';
  const calls = [];
  if (!live) await page.route('**/api/usage/reports?*', async route => {
    const url = new URL(route.request().url());
    calls.push(Object.fromEntries(url.searchParams));
    if (mode === 'race' && url.searchParams.get('keyId') === 'other') await new Promise(resolve => setTimeout(resolve, 900));
    if (mode === 'loading') await new Promise(resolve => setTimeout(resolve, 1200));
    if (mode === 'error') return route.fulfill({ status: 400, json: { error: 'Synthetic invalid filter' } });
    const data = fixture(url);
    if (mode === 'empty') Object.assign(data, { summary: aggregate(0), daily: [], byModel: [], byAccount: [], requests: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 } });
    return route.fulfill({ json: data });
  });
  await page.goto(`${base}/dashboard/usage?tab=reports`);
  await page.getByTestId('metric-requests').waitFor();
  assert.equal(await page.getByLabel('Timezone', { exact: true }).inputValue(), 'America/New_York');
  await page.getByLabel('Start date', { exact: true }).fill('2026-10-01');
  await page.getByLabel('End date', { exact: true }).fill('2026-10-31');
  await page.getByLabel('Timezone', { exact: true }).fill('Asia/Jakarta');
  await page.getByLabel('Inference API key', { exact: true }).selectOption('kenny');
  const applied = page.waitForResponse(r => r.url().includes('/api/usage/reports?') && new URL(r.url()).searchParams.get('keyId') === 'kenny');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  const json = await (await applied).json();
  await page.getByTestId('metric-requests').waitFor();
  assert.equal(await page.getByTestId('metric-requests').textContent(), String(json.summary.requests));
  assert.equal(json.summary.requests, 31);
  assert.equal(json.filters.timezone, 'Asia/Jakarta');
  assert.equal(json.daily.reduce((sum, row) => sum + row.requests, 0), 31);
  assert.equal(json.byModel.reduce((sum, row) => sum + row.requests, 0), 31);
  assert.equal(await page.getByTestId('report-requests').locator('tbody tr').count(), 25);
  const nextResponse = page.waitForResponse(r => r.url().includes('/api/usage/reports?') && new URL(r.url()).searchParams.get('page') === '2');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  const next = await (await nextResponse).json();
  await page.getByTestId('metric-requests').waitFor();
  assert.equal(next.cutoff, json.cutoff);
  assert.equal(await page.getByTestId('report-requests').locator('tbody tr').count(), 6);
  if (live) {
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download XLSX' }).click();
    const download = await downloadEvent;
    const file = path.join(out, 'synthetic-usage-report.xlsx');
    await download.saveAs(file);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file);
    assert.deepEqual(workbook.worksheets.map(s => s.name), ['Summary & Filters', 'Daily Usage', 'By Model', 'By Account', 'Requests']);
    assert.equal(workbook.getWorksheet('Requests').rowCount - 1, 31);
    const values = workbook.getWorksheet('Summary & Filters').getSheetValues();
    assert.ok(JSON.stringify(values).includes('Asia/Jakarta'));
    // Match a numeric summary count, never a formatted numeric string.
    for (const metric of ['requests', ...metrics]) {
      const row = values.find(row => row?.[1] === metric);
      assert.ok(row, `Missing Summary metric ${metric}`);
      assert.equal(row[2] ?? null, json.summary[metric], `Summary ${metric}`);
    }
    const requestSheet = workbook.getWorksheet('Requests');
    const headers = requestSheet.getRow(1).values;
    for (const metric of metrics) {
      const column = headers.indexOf(metric);
      assert.ok(column > 0, `Missing request metric ${metric}`);
      const cells = requestSheet.getSheetValues().slice(2).map(row => row[column]).filter(value => typeof value === 'number');
      const total = cells.length ? cells.reduce((sum, value) => sum + value, 0) : null;
      if (total === null) assert.equal(json.summary[metric], null);
      else assert.ok(Math.abs(total - json.summary[metric]) < 1e-9, `Requests reconciliation ${metric}`);
    }
    assert.ok(!JSON.stringify(workbook.model).includes('synthetic-raw-key'));
    for (const sheet of workbook.worksheets) sheet.eachRow(row => row.eachCell(cell => assert.notEqual(cell.type, ExcelJS.ValueType.Formula)));
  }
  const measurements = [];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByTestId('report-charts').waitFor();
    await page.mouse.move(0, 0);
    const measure = await page.evaluate(() => {
      const panel = document.querySelector('.overflow-y-auto.custom-scrollbar');
      const report = document.querySelector('section[aria-label="Usage reports"]');
      return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        panel: { scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth, scrollHeight: panel.scrollHeight },
        report: { width: report.getBoundingClientRect().width, height: report.getBoundingClientRect().height },
        chartCount: document.querySelectorAll('[data-testid="report-charts"] .recharts-wrapper').length };
    });
    assert.ok(measure.scrollWidth <= width, JSON.stringify(measure));
    assert.ok(measure.panel.scrollWidth <= measure.panel.clientWidth, JSON.stringify(measure));
    assert.equal(measure.chartCount, 2);
    // Dashboard uses an inner scroller: expand only the capture viewport so all
    // report content is actually visible, keeping the target width unchanged.
    await page.setViewportSize({ width, height: Math.ceil(measure.panel.scrollHeight + 200) });
    await page.getByRole('region', { name: 'Usage reports' }).screenshot({ path: path.join(out, `reports-${live ? 'live' : 'mock'}-${width}.png`) });
    measurements.push(measure);
  }
  if (!live) {
    mode = 'loading';
    await page.getByRole('button', { name: 'Refresh snapshot' }).click();
    await page.getByText('Loading report…', { exact: true }).waitFor();
    await page.getByTestId('metric-requests').waitFor();
    mode = 'empty';
    await page.getByRole('button', { name: 'Refresh snapshot' }).click();
    await page.getByText('No recorded requests match these filters.').waitFor();
    mode = 'error';
    await page.getByRole('button', { name: 'Refresh snapshot' }).click();
    const reportAlert = page.getByRole('region', { name: 'Usage reports' }).getByRole('alert');
    await reportAlert.waitFor();
    assert.ok((await reportAlert.textContent()).includes('Synthetic invalid filter'));
    mode = 'normal';
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByTestId('metric-requests').waitFor();
    mode = 'race';
    await page.getByLabel('Inference API key', { exact: true }).selectOption('other');
    const slowRequest = page.waitForRequest(r => r.url().includes('/api/usage/reports?') && new URL(r.url()).searchParams.get('keyId') === 'other');
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await slowRequest;
    await page.getByLabel('Inference API key', { exact: true }).selectOption('kenny');
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await page.getByTestId('metric-requests').waitFor();
    assert.equal(await page.getByTestId('metric-requests').textContent(), '31');
    // Wait only for this deliberately delayed test response, not background work.
    await page.waitForTimeout(1000);
    assert.equal(await page.getByTestId('metric-requests').textContent(), '31');
  }
  // Expected HTTP400 error-state console line is not a runtime/component error.
  const unexpectedErrors = errors.filter(e => !e.includes('400 (Bad Request)'));
  assert.deepEqual(unexpectedErrors, []);
  await fs.writeFile(path.join(out, `reports-${live ? 'live' : 'mock'}.report.json`), JSON.stringify({ mode: live ? 'live synthetic DB' : 'mock state coverage', measurements, errors, unexpectedErrors, calls, summary: json.summary, cutoff: json.cutoff, pagination: next.pagination }, null, 2));
  await browser.close();
  console.log(`REPORT_BROWSER_OK ${live ? 'live' : 'mock'} ${out}`);
})().catch(e => { console.error(e); process.exit(1); });
