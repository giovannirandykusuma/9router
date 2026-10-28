import { DateTime, IANAZone } from 'luxon';

export const LIMITS = { maxDays: 366, maxExportRows: 50000 };
export class ReportError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const ALLOWED = new Set(['startDate', 'endDate', 'timezone', 'keyId', 'provider', 'connectionId', 'model', 'page', 'pageSize', 'cutoff', 'exportMode']);
function integer(value, fallback, min, max) {
  if (value === null) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new ReportError('Invalid integer parameter');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new ReportError('Integer parameter out of range');
  return number;
}
export function normalizeFilters(params, { requireCutoff = false } = {}) {
  for (const key of params.keys()) {
    if (!ALLOWED.has(key) || params.getAll(key).length !== 1) throw new ReportError('Unknown or duplicate parameter');
  }
  const timezone = params.get('timezone');
  if (!timezone || timezone.length > 100 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(timezone) || !IANAZone.isValidZone(timezone)) throw new ReportError('Invalid IANA timezone');
  const dates = ['startDate', 'endDate'].map((key) => {
    const value = params.get(key);
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ReportError('Dates must use YYYY-MM-DD');
    const date = DateTime.fromISO(value, { zone: timezone }).startOf('day');
    if (!date.isValid || date.toISODate() !== value || date.year < 1 || date.year > 9998) throw new ReportError('Invalid calendar date');
    return date;
  });
  const [start, end] = dates;
  // Count calendar labels, not elapsed local-midnight hours (midnight itself
  // can be skipped by DST). This also reliably rejects reversed ranges.
  const days = DateTime.fromISO(end.toISODate(), { zone: 'UTC' })
    .diff(DateTime.fromISO(start.toISODate(), { zone: 'UTC' }), 'days').days + 1;
  if (days < 1 || days > LIMITS.maxDays) throw new ReportError('Range must contain 1 to 366 calendar days');
  const filters = { startDate: start.toISODate(), endDate: end.toISODate(), timezone,
    startUtc: start.toUTC().toISO(), endUtc: end.plus({ days: 1 }).startOf('day').toUTC().toISO() };
  for (const key of ['keyId', 'provider', 'connectionId', 'model']) {
    const value = params.get(key);
    if (value !== null) {
      if (!value || value.length > 256 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) throw new ReportError('Invalid filter identifier');
      filters[key] = value;
    }
  }
  const exportMode = params.get('exportMode');
  if (exportMode !== null) {
    if (!requireCutoff || !['summary', 'details'].includes(exportMode)) throw new ReportError('Invalid export mode');
    filters.exportMode = exportMode;
  }
  filters.page = integer(params.get('page'), 1, 1, 100000000);
  filters.pageSize = integer(params.get('pageSize'), 25, 1, 100);
  const cutoff = integer(params.get('cutoff'), null, 0, Number.MAX_SAFE_INTEGER);
  if (requireCutoff && cutoff === null) throw new ReportError('Export requires cutoff');
  if (cutoff !== null) filters.cutoff = cutoff;
  return filters;
}
export function dayBoundaries(filters) {
  const days = [];
  let date = DateTime.fromISO(filters.startDate, { zone: filters.timezone }).startOf('day');
  while (date.toISODate() <= filters.endDate) {
    const next = date.plus({ days: 1 }).startOf('day');
    days.push({ date: date.toISODate(), start: date.toUTC().toISO(), end: next.toUTC().toISO() });
    date = next;
  }
  return days;
}
