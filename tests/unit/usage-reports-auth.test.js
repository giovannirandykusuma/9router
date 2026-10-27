import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { SignJWT } from 'jose';

const mocks = vi.hoisted(() => ({ getAdapter: vi.fn(), executeReport: vi.fn() }));
vi.mock('@/lib/db/driver.js', () => ({ getAdapter: mocks.getAdapter }));
vi.mock('@/lib/usage-reports/executor.js', () => ({ executeReport: mocks.executeReport }));
vi.mock('@/lib/localDb', () => ({ getSettings: vi.fn(async () => ({ requireLogin: false })) }));
let GET, EXPORT, createDashboardAuthToken, temp;
const priorDir = process.env.DATA_DIR;
const priorSecret = process.env.JWT_SECRET;
beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'report-auth-'));
  process.env.DATA_DIR = temp;
  process.env.JWT_SECRET = 'synthetic-report-auth-secret';
  ({ GET } = await import('@/app/api/usage/reports/route.js'));
  ({ GET: EXPORT } = await import('@/app/api/usage/reports/export/route.js'));
  ({ createDashboardAuthToken } = await import('@/lib/auth/dashboardSession.js'));
});
afterAll(() => {
  if (priorDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = priorDir;
  if (priorSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = priorSecret;
  fs.rmSync(temp, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAdapter.mockResolvedValue({ driver: 'node:sqlite' });
  mocks.executeReport.mockImplementation(async ({ fullExport }) => new TextEncoder().encode(fullExport ? 'xlsx' : JSON.stringify({ cutoff: 10, summary: { requests: 0 } })));
});
function request({ token, bearer, params = 'startDate=2026-01-01&endDate=2026-01-01&timezone=UTC&cutoff=10' } = {}) {
  const headers = {};
  if (token) headers.cookie = `auth_token=${token}`;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return new NextRequest(`http://localhost/api/usage/reports?${params}`, { headers });
}
describe('reports explicit dashboard admin authorization', () => {
  it('rejects absent cookies even when requireLogin=false, inference/MCP bearer credentials, and malformed cookies on both endpoints', async () => {
    for (const handler of [GET, EXPORT]) {
      for (const args of [{}, { bearer: 'inference-key' }, { bearer: 'mcp-gateway-key' }, { token: 'malformed' }]) {
        const response = await handler(request(args));
        expect(response.status).toBe(401);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
    }
    expect(mocks.getAdapter).not.toHaveBeenCalled();
    expect(mocks.executeReport).not.toHaveBeenCalled();
  });
  it('rejects expired, wrong signature and correctly signed cookies without authenticated=true', async () => {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const tokens = [await createDashboardAuthToken({ authenticated: false }), await createDashboardAuthToken({ authenticated: 'true' }),
      await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(secret),
      await new SignJWT({ authenticated: true }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime(1).sign(secret),
      await new SignJWT({ authenticated: true }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode('wrong-secret'))];
    for (const handler of [GET, EXPORT]) for (const token of tokens) expect((await handler(request({ token }))).status).toBe(401);
    expect(mocks.getAdapter).not.toHaveBeenCalled();
  });
  it('accepts valid admin cookies; returns JSON/XLSX with no-store and safe attachment headers', async () => {
    const token = await createDashboardAuthToken();
    const json = await GET(request({ token }));
    expect(json.status).toBe(200);
    expect(await json.json()).toEqual({ cutoff: 10, summary: { requests: 0 } });
    const xlsx = await EXPORT(request({ token }));
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers.get('content-type')).toContain('spreadsheetml');
    expect(xlsx.headers.get('content-disposition')).toBe('attachment; filename="usage-report.xlsx"');
    expect(xlsx.headers.get('cache-control')).toBe('no-store');
    expect(mocks.executeReport.mock.calls[1][0]).toMatchObject({ fullExport: true, driver: 'node:sqlite' });
    expect(mocks.executeReport.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
  });
  it('returns real sql.js503 without export, flush, DB reads or worker admission', async () => {
    const token = await createDashboardAuthToken();
    const { executeReport } = await vi.importActual('@/lib/usage-reports/executor.js');
    const forbidden = vi.fn(() => { throw new Error('Must not access live sql.js data'); });
    mocks.getAdapter.mockResolvedValue({ driver: 'sql.js', get: forbidden, all: forbidden, raw: { export: forbidden }, flush: forbidden });
    mocks.executeReport.mockImplementation(executeReport);
    for (const handler of [GET, EXPORT]) {
      const response = await handler(request({ token }));
      expect(response.status).toBe(503);
      expect((await response.json()).error).toContain('native SQLite');
    }
    expect(forbidden).not.toHaveBeenCalled();
  });
  it('propagates actionable unsupported-runtime and bounded lifecycle errors on both endpoints', async () => {
    const token = await createDashboardAuthToken();
    const { ReportError } = await import('@/lib/usage-reports/filters.js');
    for (const handler of [GET, EXPORT]) {
      for (const status of [503, 504, 499]) {
        mocks.executeReport.mockRejectedValueOnce(new ReportError('Isolated reporting requires native SQLite; retry on a supported runtime', status));
        const response = await handler(request({ token }));
        expect(response.status).toBe(status);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect((await response.json()).error).toContain('native SQLite');
      }
    }
  });
  it('returns bounded 400/413 errors and generic unexpected 500 without leaked internals', async () => {
    const token = await createDashboardAuthToken();
    expect((await GET(request({ token, params: 'invalid=1' }))).status).toBe(400);
    expect((await EXPORT(request({ token, params: 'startDate=2026-01-01&endDate=2026-01-01&timezone=UTC' }))).status).toBe(400);
    const { ReportError } = await import('@/lib/usage-reports/filters.js');
    expect(mocks.executeReport).not.toHaveBeenCalled();
    mocks.executeReport.mockRejectedValueOnce(new ReportError('Export exceeds 50000 requests', 413));
    expect((await EXPORT(request({ token }))).status).toBe(413);
    mocks.getAdapter.mockRejectedValueOnce(new Error('SECRET_SQL_CONNECTION_STRING'));
    const error = await GET(request({ token }));
    expect(error.status).toBe(500);
    expect(await error.text()).not.toContain('SECRET');
  });
});
