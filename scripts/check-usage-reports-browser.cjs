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
  return { filters: Object.fromEntries(p), cutoff: 62, limits: { maxDays: 366, maxExportRows: 50000 }, summary: aggregate(total), byKey: [{ keyId: 'kenny', keyName: 'Kenny (synthetic)', ...aggregate(total) }], daily: [{ date: p.get('startDate'), ...aggregate(total) }], byModel: [{ provider: 'codex', model: 'gpt-test', ...aggregate(total) }], byAccount: [{ provider: 'codex', connectionId: 'account-test', accountName: 'Synthetic account', ...aggregate(total) }], requests: Array.from({ length: Math.max(0, Math.min(25, total - (page - 1) * 25)) }, (_, i) => ({ id: (page - 1) * 25 + i, timestamp: '2026-10-15T12:00:00.000Z', provider: 'codex', model: 'gpt-test', keyId: 'kenny', keyName: 'Kenny (synthetic)', connectionId: 'account-test', accountName: 'Synthetic account', ...aggregate(1) })), pagination: { page, pageSize: 25, total, totalPages: Math.ceil(total / 25) }, options: { keys: [{ id: 'kenny', name: 'Kenny (synthetic)' }, { id: 'other', name: 'Other (synthetic)' }], providers: ['codex'], accounts: [{ id: 'account-test', name: 'Synthetic account' }], models: [{ provider: 'codex', model: 'gpt-test' }] } };
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
  await page.getByLabel('Provider', { exact: true }).selectOption('codex');
  await page.getByLabel('Account', { exact: true }).selectOption('account-test');
  await page.getByLabel('Exact model', { exact: true }).fill('gpt-test');
  const applied = page.waitForResponse(r => r.url().includes('/api/usage/reports?') && new URL(r.url()).searchParams.get('keyId') === 'kenny');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  const json = await (await applied).json();
  await page.getByTestId('metric-requests').waitFor();
  assert.equal(await page.getByTestId('metric-requests').textContent(), String(json.summary.requests));
  assert.equal(json.summary.requests, 31);
  assert.equal(json.filters.timezone, 'Asia/Jakarta');
  assert.equal(json.filters.provider, 'codex');
  assert.equal(json.filters.connectionId, 'account-test');
  assert.equal(json.filters.model, 'gpt-test');
  assert.equal(json.daily.reduce((sum, row) => sum + row.requests, 0), 31);
  assert.equal(json.byModel.reduce((sum, row) => sum + row.requests, 0), 31);
  assert.equal(await page.getByTestId('report-requests').locator('tbody tr').count(), 25);
  const nextResponse = page.waitForResponse(r => r.url().includes('/api/usage/reports?') && new URL(r.url()).searchParams.get('page') === '2');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  const next = await (await nextResponse).json();
  await page.getByTestId('metric-requests').waitFor();
  assert.equal(next.cutoff, json.cutoff);
  assert.equal(await page.getByTestId('report-requests').locator('tbody tr').count(), 6);
  assert.equal(await page.getByTestId('report-keys').locator('tbody tr').count(), 1);
  if (live) {
    const aggregateDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download aggregated Excel', exact: true }).click();
    const aggregateFile = path.join(out, 'synthetic-aggregate-report.xlsx');
    await (await aggregateDownload).saveAs(aggregateFile);
    const aggregateWorkbook = new ExcelJS.Workbook();
    await aggregateWorkbook.xlsx.readFile(aggregateFile);
    assert.deepEqual(aggregateWorkbook.worksheets.map(s => s.name), ['Summary & Filters', 'Daily Usage', 'By API Key', 'By Model', 'By Account']);
    assert.equal(aggregateWorkbook.getWorksheet('By API Key').getRow(2).getCell(3).value, 31);
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download with request details' }).click();
    const download = await downloadEvent;
    const file = path.join(out, 'synthetic-usage-report.xlsx');
    await download.saveAs(file);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file);
    assert.deepEqual(workbook.worksheets.map(s => s.name), ['Summary & Filters', 'Daily Usage', 'By API Key', 'By Model', 'By Account', 'Requests']);
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
  const measureReports = () => {
    const report = document.querySelector('section[aria-label="Usage reports"]');
    // Sidebar navs share these classes. Only the report's own ancestor is valid.
    const panel = report.closest('.overflow-y-auto.custom-scrollbar');
    if (!panel || !panel.closest('main')) throw new Error('Reports main scroller not found');
    const rect = element => {
      const { x, y, width, height, top, right, bottom, left } = element.getBoundingClientRect();
      return { x, y, width, height, top, right, bottom, left };
    };
    const bounds = rect(report);
    const contains = (outer, inner) => inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom;
    const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const ancestors = [];
    for (let element = report.parentElement; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      const box = rect(element);
      const clip = { left: box.left + element.clientLeft, top: box.top + element.clientTop };
      clip.right = clip.left + element.clientWidth;
      clip.bottom = clip.top + element.clientHeight;
      const clipsX = /auto|scroll|hidden|clip/.test(style.overflowX);
      const clipsY = /auto|scroll|hidden|clip/.test(style.overflowY);
      ancestors.push({ tag: element.tagName, className: element.className, overflowX: style.overflowX, overflowY: style.overflowY, clip,
        containsReport: (!clipsX || (bounds.left >= clip.left && bounds.right <= clip.right)) && (!clipsY || (bounds.top >= clip.top && bounds.bottom <= clip.bottom)) });
    }
    const buttons = [...report.querySelectorAll('button')].filter(button => ['Previous', 'Next'].includes(button.textContent.trim()));
    const pagination = buttons.map(button => {
      const box = rect(button);
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      const style = getComputedStyle(button);
      return { label: button.textContent.trim(), rect: box, disabled: button.disabled,
        visible: box.width > 0 && box.height > 0 && style.visibility === 'visible' && style.display !== 'none' && contains(viewport, box) && contains(bounds, box) && (hit === button || button.contains(hit)) };
    });
    const sections = ['report-charts', 'report-accounts', 'report-requests'].map(id => {
      const element = report.querySelector(`[data-testid="${id}"]`);
      // Tables may scroll horizontally by design; measure their visible wrapper.
      const box = rect(id === 'report-charts' ? element : element.closest('[role="region"]'));
      return { id, rect: box, visible: box.width > 0 && box.height > 0 && contains(viewport, box) && contains(bounds, box) };
    });
    return { viewport: innerWidth, viewportHeight: innerHeight, scrollWidth: document.documentElement.scrollWidth,
      panel: { tag: panel.tagName, inMain: true, containsReport: panel.contains(report), scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth, scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight, scrollTop: panel.scrollTop, rect: rect(panel) },
      report: bounds, fullyVisible: contains(viewport, bounds) && ancestors.every(ancestor => ancestor.containsReport), ancestors, pagination, sections,
      chartCount: report.querySelectorAll('[data-testid="report-charts"] .recharts-wrapper').length,
      visibleTooltips: [...report.querySelectorAll('.recharts-tooltip-wrapper')].filter(element => getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none').length,
      devBadgeVisible: [...document.querySelectorAll('nextjs-portal')].some(element => element.getBoundingClientRect().width > 0 && getComputedStyle(element).display !== 'none') };
  };
  // Capture-only: no product config change, and no dev chrome over report content.
  const captureStyle = await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  try {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.getByTestId('report-charts').waitFor();
      await page.evaluate(async () => { await document.fonts.ready; });
      // Recharts updates through ResizeObserver/React after the viewport resize.
      // Wait for its real SVG layout, rather than measuring stale desktop widths.
      await page.waitForFunction(() => {
        const charts = [...document.querySelectorAll('[data-testid="report-charts"] .recharts-wrapper')];
        return charts.length === 2 && charts.every(chart => {
          const container = chart.closest('.recharts-responsive-container');
          return chart.getBoundingClientRect().width > 0 && Math.abs(chart.getBoundingClientRect().width - container.getBoundingClientRect().width) < 1;
        });
      });
      const afterResize = await page.evaluate(measureReports);
      // Preserve tooltip coordinates as resize-regression evidence. Hidden
      // tooltips may retain desktop offsets, but must not overflow the main panel.
      const resizeOverflow = await page.evaluate(() => {
        const report = document.querySelector('section[aria-label="Usage reports"]');
        const panel = report.closest('.overflow-y-auto.custom-scrollbar');
        return [...report.querySelectorAll('.recharts-tooltip-wrapper')].map(element => ({
          selector: '.recharts-tooltip-wrapper', visibility: getComputedStyle(element).visibility,
          x: element.getBoundingClientRect().x, right: element.getBoundingClientRect().right,
          panelRight: panel.getBoundingClientRect().right,
        }));
      });
      assert.ok(afterResize.panel.scrollWidth <= afterResize.panel.clientWidth, JSON.stringify(afterResize));
      await page.mouse.move(0, 0);
      const original = await page.evaluate(measureReports);
      assert.ok(original.panel.clientWidth > 0 && original.panel.clientHeight > 0);
      assert.ok(original.scrollWidth <= width, JSON.stringify(original));
      assert.ok(original.panel.scrollWidth <= original.panel.clientWidth, JSON.stringify(original));
      // Include the real main scroller's entire content plus all surrounding chrome.
      // Keep the responsive width unchanged; do not rely on locator screenshots to
      // paint content outside a clipped inner scroller (they can silently be blank).
      await page.setViewportSize({ width, height: Math.ceil(original.panel.scrollHeight + original.viewportHeight - original.panel.clientHeight + 32) });
      await page.evaluate(async () => {
        const report = document.querySelector('section[aria-label="Usage reports"]');
        for (let element = report.parentElement; element; element = element.parentElement) { element.scrollTop = 0; element.scrollLeft = 0; }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await page.mouse.move(0, 0);
      const measure = await page.evaluate(measureReports);
      assert.equal(measure.viewport, width);
      assert.ok(measure.scrollWidth <= width, JSON.stringify(measure));
      assert.ok(measure.panel.scrollWidth <= measure.panel.clientWidth, JSON.stringify(measure));
      assert.ok(measure.panel.scrollHeight <= measure.panel.clientHeight, JSON.stringify(measure));
      assert.ok(measure.report.width > 0 && measure.report.height > 0);
      assert.equal(measure.chartCount, 2);
      assert.equal(measure.fullyVisible, true, JSON.stringify(measure));
      assert.deepEqual(measure.pagination.map(button => button.label), ['Previous', 'Next']);
      assert.ok(measure.pagination.every(button => button.visible), JSON.stringify(measure.pagination));
      assert.ok(measure.sections.every(section => section.visible), JSON.stringify(measure.sections));
      assert.equal(measure.devBadgeVisible, false);
      assert.equal(measure.visibleTooltips, 0);
      const file = path.join(out, `reports-${live ? 'live' : 'mock'}-${width}.png`);
      await page.getByRole('region', { name: 'Usage reports', exact: true }).screenshot({ path: file, animations: 'disabled', scale: 'css' });
      const png = await fs.readFile(file);
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      const dimensions = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
      assert.equal(dimensions.width, Math.ceil(measure.report.width), 'PNG width must match full report');
      assert.equal(dimensions.height, Math.ceil(measure.report.height), 'PNG height must match full report');
      const after = await page.evaluate(measureReports);
      assert.deepEqual(after.report, measure.report, 'Screenshot must not move or resize the report');
      assert.equal(after.fullyVisible, true);
      assert.ok(after.pagination.every(button => button.visible));
      measurements.push({ ...measure, original, afterResize, resizeOverflow, png: { path: file, ...dimensions }, geometryVerified: true });
    }
  } finally {
    await captureStyle.evaluate(element => element.remove());
    await page.setViewportSize({ width: 390, height: 1000 });
  }
  if (!live) {
    // High-volume reports must never disable aggregated downloads.
    await page.route('**/api/usage/reports?*', async route => {
      const data = fixture(new URL(route.request().url()));
      data.summary = aggregate(50001);
      await route.fulfill({ json: data });
    }, { times: 1 });
    await page.getByRole('button', { name: 'Refresh snapshot' }).click();
    await page.getByTestId('metric-requests').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Download aggregated Excel', exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Download with request details', exact: true }).isDisabled(), true);
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
