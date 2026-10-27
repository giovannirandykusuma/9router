import { getDashboardAuthSession } from '@/lib/auth/dashboardSession.js';
import { getAdapter } from '@/lib/db/driver.js';
import { normalizeFilters, ReportError } from './filters.js';
import { DATA_FILE } from '@/lib/db/paths.js';
import { executeReport } from './executor.js';

export async function handleReportRequest(request, { fullExport = false } = {}) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    // No bearer fallback, and deliberately no requireLogin/settings bypass.
    const token = request.cookies?.get('auth_token')?.value;
    const session = token ? await getDashboardAuthSession(token) : null;
    if (session?.authenticated !== true) return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
    const filters = normalizeFilters(new URL(request.url).searchParams, { requireCutoff: fullExport });
    const adapter = await getAdapter();
    const bytes = await executeReport({ driver: adapter.driver, filePath: DATA_FILE, filters, fullExport }, { signal: request.signal });
    if (!fullExport) return new Response(bytes, { headers: { ...headers, 'Content-Type': 'application/json' } });
    return new Response(bytes, { headers: { ...headers,
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="usage-report.xlsx"',
      'X-Content-Type-Options': 'nosniff' } });
  } catch (error) {
    const expected = error instanceof ReportError;
    return Response.json({ error: expected ? error.message : 'Unable to generate usage report' },
      { status: expected ? error.status : 500, headers });
  }
}
