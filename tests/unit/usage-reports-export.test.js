import { describe, it, expect, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { createReportWorkbook } from '@/lib/usage-reports/export.js';
import { queryReport, METRICS } from '@/lib/usage-reports/query.js';
import { normalizeFilters } from '@/lib/usage-reports/filters.js';

function fixture() {
  const metrics = { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedTokens: 8, cacheCreationTokens: null, reasoningTokens: 3, cost: 0.123 };
  const known = Object.fromEntries(METRICS.map((m) => [m, metrics[m] === null ? 0 : 1]));
  return { filters: { startDate: '2026-03-08', endDate: '2026-03-08', timezone: 'America/New_York', startUtc: '2026-03-08T05:00:00.000Z', endUtc: '2026-03-09T04:00:00.000Z' }, cutoff: 42,
    summary: { ...metrics, known }, daily: [{ date: '2026-03-08', ...metrics, known }],
    byModel: [{ provider: '@SUM(1)', model: '=HYPERLINK("https://evil")', ...metrics, known }],
    byKey: [{ keyId: 'key', keyName: '=Default', ...metrics, known }],
    byAccount: [{ provider: '-1+1', connectionId: 'account', accountName: '+cmd|A1', ...metrics, known }],
    requests: [{ id: 42, timestamp: '2026-03-08T12:00:00.000Z', provider: '@SUM(1)', model: '=HYPERLINK("https://evil")', connectionId: 'account', accountName: '\t=1+1', keyId: 'key', keyName: '\n+cmd|A1', ...metrics,
      apiKey: 'SHOULD_NOT_EXPORT_RAW_KEY', tokens: { secret: 'SHOULD_NOT_EXPORT_TOKENS' }, meta: { prompt: 'SHOULD_NOT_EXPORT_PROMPT' }, endpoint: 'SHOULD_NOT_EXPORT_ENDPOINT' }],
  };
}
describe('usage report XLSX', () => {
  it('round-trips six sheets, numeric totals, coverage, timezone and unknown blank cells', async () => {
    const report = fixture();
    const buffer = await createReportWorkbook(report);
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    const workbook = await new ExcelJS.Workbook().xlsx.load(buffer);
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['Summary & Filters', 'Daily Usage', 'By API Key', 'By Model', 'By Account', 'Requests']);
    const summary = new Map(workbook.getWorksheet('Summary & Filters').getSheetValues().filter(Boolean).map((row) => [row[1], row[2]]));
    expect(summary.get('timezone')).toBe('America/New_York');
    expect(summary.get('cutoff')).toBe(42);
    expect(summary.get('totalTokens')).toBe(15);
    expect(summary.get('cost')).toBe(0.123);
    const sheet = workbook.getWorksheet('Requests');
    const headers = sheet.getRow(1).values.slice(1);
    const row = sheet.getRow(2);
    for (const metric of METRICS) {
      const cell = row.getCell(headers.indexOf(metric) + 1);
      expect(cell.value).toBe(report.summary[metric]);
      if (cell.value !== null) expect(cell.type).toBe(ExcelJS.ValueType.Number);
    }
    const daily = workbook.getWorksheet('Daily Usage');
    expect(daily.getRow(2).getCell(8).value).toBe(report.summary.totalTokens);
  });
  it('downloads a five-sheet aggregate workbook without misleading request rows', async () => {
    const report = fixture();
    report.filters.exportMode = 'summary';
    const workbook = await new ExcelJS.Workbook().xlsx.load(await createReportWorkbook(report));
    expect(workbook.worksheets.map(s => s.name)).toEqual(['Summary & Filters', 'Daily Usage', 'By API Key', 'By Model', 'By Account']);
    expect(workbook.getWorksheet('By API Key').getRow(2).getCell(2).value).toBe('=Default');
    expect(workbook.getWorksheet('By API Key').getRow(2).getCell(3).value).toBe(1);
    expect(JSON.stringify(workbook.model)).toContain('individual request rows intentionally not included');
  });
  it('writes formula-looking names as literal strings and excludes all unapproved fields', async () => {
    const workbook = await new ExcelJS.Workbook().xlsx.load(await createReportWorkbook(fixture()));
    const serialized = JSON.stringify(workbook.model);
    expect(serialized).not.toContain('SHOULD_NOT_EXPORT');
    let strings = 0;
    for (const sheet of workbook.worksheets) sheet.eachRow((row) => row.eachCell((cell) => {
      expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
      expect(cell.hyperlink).toBeUndefined();
      if (typeof cell.value === 'string' && /^[=+\-@\t\n]/.test(cell.value)) {
        expect(cell.type).toBe(ExcelJS.ValueType.String); strings++;
      }
    }));
    expect(strings).toBeGreaterThanOrEqual(7);
  });
  it('rejects over 50000 matches before aggregate or workbook creation and requires export cutoff', () => {
    const filters = normalizeFilters(new URLSearchParams({ startDate: '2026-01-01', endDate: '2026-01-01', timezone: 'UTC', cutoff: '100000' }));
    const db = { transaction: (fn) => fn(), get: vi.fn((sql) => sql.includes('MAX(id)') ? { cutoff: 100000 }
      : sql.includes('total_changes') ? { n: 0 } : sql.includes('data_version') ? { data_version: 1 } : { total: 50001 }), all: vi.fn() };
    expect(() => queryReport(db, filters, { fullExport: true })).toThrow(/50000/);
    expect(db.get).toHaveBeenCalledTimes(4);
    expect(db.all).not.toHaveBeenCalled();
    expect(() => normalizeFilters(new URLSearchParams({ startDate: '2026-01-01', endDate: '2026-01-01', timezone: 'UTC' }), { requireCutoff: true })).toThrow(/cutoff/);
  });
});
