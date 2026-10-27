import { handleReportRequest } from '@/lib/usage-reports/http.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request) {
  return handleReportRequest(request, { fullExport: true });
}
