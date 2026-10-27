import ExcelJS from 'exceljs';
import { PassThrough } from 'node:stream';
import { METRICS } from './query.js';

const metricHeaders = METRICS.flatMap((metric) => [metric, `known.${metric}`]);
function aggregateValues(row) {
  return METRICS.flatMap((metric) => [row[metric], row.known[metric]]);
}
// Values are primitives only. ExcelJS stores strings as literal string cells,
// including =, +, -, @, tabs and newlines; never construct formula/hyperlink objects.
function addRow(sheet, values) {
  sheet.addRow(values.map((value) => value === null || value === undefined ? null
    : typeof value === 'number' ? value : String(value))).commit();
}
export async function createReportWorkbook(report) {
  const stream = new PassThrough();
  const chunks = [];
  const completed = new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: false, useSharedStrings: false });
  workbook.creator = '9Router';
  const summary = workbook.addWorksheet('Summary & Filters');
  addRow(summary, ['Field', 'Value', 'Recorded rows']);
  addRow(summary, ['Scope', 'Recorded inference requests only; excludes MCP gateway']);
  addRow(summary, ['Cost basis', 'Saved historical estimate; not an invoice or subscription charge']);
  addRow(summary, ['Missing metrics', 'Blank means unknown; partial sums include recorded values only']);
  addRow(summary, ['cutoff', report.cutoff]);
  for (const key of ['startDate', 'endDate', 'timezone', 'startUtc', 'endUtc', 'keyId', 'provider', 'connectionId', 'model']) {
    if (report.filters[key] !== undefined) addRow(summary, [key, report.filters[key]]);
  }
  for (const metric of METRICS) addRow(summary, [metric, report.summary[metric], report.summary.known[metric]]);
  summary.commit();
  for (const [name, rows, fields] of [
    ['Daily Usage', report.daily, ['date']],
    ['By Model', report.byModel, ['provider', 'model']],
    ['By Account', report.byAccount, ['provider', 'connectionId', 'accountName']],
  ]) {
    const sheet = workbook.addWorksheet(name);
    addRow(sheet, [...fields, ...metricHeaders]);
    for (const row of rows) addRow(sheet, [...fields.map((field) => row[field]), ...aggregateValues(row)]);
    sheet.commit();
  }
  const requests = workbook.addWorksheet('Requests');
  const fields = ['id', 'timestamp', 'provider', 'model', 'connectionId', 'accountName', 'keyId', 'keyName', ...METRICS];
  addRow(requests, fields);
  for (const row of report.requests) addRow(requests, fields.map((field) => row[field]));
  requests.commit();
  await workbook.commit();
  return completed;
}
