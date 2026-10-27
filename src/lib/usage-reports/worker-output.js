import { ReportError } from './filters.js';

export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

// Called only in the worker. The post-encoding bound limits bytes transferred
// and retained by the gateway; it is not a cap on peak encoding memory.
export async function encodeReport(report, fullExport, maxBytes = MAX_OUTPUT_BYTES) {
  const bytes = fullExport
    ? await (await import('./export.js')).createReportWorkbook(report)
    : new TextEncoder().encode(JSON.stringify(report));
  if (bytes.byteLength > maxBytes) throw new ReportError('Report output is too large; narrow the filters', 413);
  return Uint8Array.from(bytes);
}
